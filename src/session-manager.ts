import { createEngine } from './engines/create-engine.js';
import type { IEngineFactory } from './engines/engine-contract.js';
import { EngineRegistry } from './engines/engine-registry.js';
import { EngineError } from './errors.js';
import {
  emptyTokenUsage,
  mergeEngineConfig,
  mergeTokenUsage,
  roundUsd,
} from './engines/shared.js';
import { ContextStore } from './orchestration/context-store.js';
import type { ContextEntry } from './orchestration/context-store.js';
import { ContextEventStore } from './orchestration/context-events.js';
import { RoleRegistry } from './orchestration/roles.js';
import type { AgentRole } from './orchestration/roles.js';
import { RoleStore } from './orchestration/role-store.js';
import type { RelayResult, BroadcastResult, BroadcastTargetResult } from './orchestration/relay.js';
import { WorkflowEngine } from './orchestration/workflow-engine.js';
import type { WorkflowDefinition, WorkflowState } from './orchestration/workflow-types.js';
import { CircuitBreaker } from './orchestration/circuit-breaker.js';
import type { CircuitSnapshot } from './orchestration/circuit-breaker.js';
import { HealthChecker } from './orchestration/health-check.js';
import type { HealthCheckResult } from './orchestration/health-check.js';
import { SessionQueue } from './orchestration/session-queue.js';
import type { QueuePriority, QueueSnapshot } from './orchestration/session-queue.js';
import { AdaptiveRouter } from './orchestration/adaptive-router.js';
import type { RoutingStats, RoutingStrategy } from './orchestration/adaptive-router.js';
import { RoutingStatsStore } from './orchestration/routing-stats-store.js';
import { classifyTask } from './orchestration/task-classifier.js';
import { expandFallbackChain } from './routing/expand-fallback-chain.js';
import {
  appendRoutingAttempt,
  createRoutingTrace,
  toRoutingAttempt,
} from './routing/routing-trace.js';
import {
  resolveDefaultRoute,
  resolveModelRoute,
} from './routing/resolve-model-route.js';
import { selectPrimaryEngine } from './routing/select-engine.js';
import { cleanupExpiredSessions } from './sessions/session-cleanup.js';
import {
  cloneSession,
  createEmptyBreakdownMap,
  syncSession,
  toSessionInfo,
} from './sessions/session-info.js';
import { SessionEventStore } from './sessions/session-events.js';
import type { SessionEvent } from './sessions/session-events.js';
import { SessionStore } from './sessions/session-store.js';
import { SessionMutex } from './sessions/session-mutex.js';
import { StructuredLogger } from './logging.js';
import type { ExternalLogger } from './logging.js';
import type { SessionRecord } from './sessions/types.js';
import type {
  CostReport,
  EngineConfig,
  EngineCostBreakdown,
  EngineKind,
  ISession,
  SentinelBridgeConfig,
  SendMessageResult,
  SessionInfo,
  SessionOverview,
  SessionStartOptions,
  SessionSummary,
  TokenUsage,
  TurnUsage,
} from './types.js';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_SESSIONS = 8;

const SESSION_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,63}$/;

export function validateSessionName(name: string): void {
  if (!SESSION_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid session name "${name}". ` +
      'Must be 1-64 characters: letters, digits, spaces, hyphens, underscores. ' +
      'Must start with a letter or digit.',
    );
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly config: SentinelBridgeConfig;
  private readonly store = new SessionStore();
  private readonly mutex = new SessionMutex();
  private readonly rehydrating = new Set<string>();
  readonly events = new SessionEventStore();
  readonly context = new ContextStore();
  readonly contextEvents = new ContextEventStore();
  readonly roles: RoleRegistry;
  private readonly roleStore = new RoleStore();
  readonly workflows: WorkflowEngine;
  readonly circuitBreaker: CircuitBreaker;
  readonly healthChecker: HealthChecker;
  readonly sessionQueue: SessionQueue;
  readonly adaptiveRouter: AdaptiveRouter;
  private readonly routingStatsStore: RoutingStatsStore;
  readonly registry: EngineRegistry;
  readonly log: StructuredLogger;
  private cleanupTimer: {
    unref?: () => void;
  } | null = null;

  constructor(config: SentinelBridgeConfig = {}, externalLogger?: ExternalLogger) {
    this.config = config;
    this.registry = new EngineRegistry();
    this.roles = new RoleRegistry(this.roleStore.list());
    this.circuitBreaker = new CircuitBreaker(config.circuitBreaker);
    this.healthChecker = new HealthChecker(config.healthCheck, this.circuitBreaker);
    this.sessionQueue = new SessionQueue(config.queue);
    this.workflows = new WorkflowEngine();
    this.log = new StructuredLogger(externalLogger);
    this.routingStatsStore = new RoutingStatsStore();
    this.adaptiveRouter = new AdaptiveRouter();
    // Bootstrap from persisted stats
    const persistedStats = this.routingStatsStore.load();
    if (persistedStats.length > 0) {
      this.adaptiveRouter.importStats(persistedStats);
    }

    const cleanupIntervalMs =
      config.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;

    if (cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupExpiredSessions();
      }, cleanupIntervalMs) as unknown as {
        unref?: () => void;
      };

      this.cleanupTimer.unref?.();
    }
  }

  registerEngine(factory: IEngineFactory): void {
    this.registry.register(factory);
  }

  async startSession(options: SessionStartOptions): Promise<SessionInfo> {
    // Resolve role and apply role defaults for engine/model if not explicitly set
    const role = options.role ? this.roles.get(options.role) : undefined;
    if (options.role && !role) {
      throw new Error(`Unknown role "${options.role}". Use sb_role_list to see available roles.`);
    }

    const effectiveEngine = options.engine ?? role?.preferredEngine;
    const effectiveModel = options.model ?? role?.preferredModel;

    const routedPrimary = effectiveModel
      ? this.resolveModelRoute(effectiveModel, effectiveEngine)
      : undefined;
    const primaryEngine = selectPrimaryEngine(
      this.config,
      { ...options, engine: effectiveEngine },
      routedPrimary?.engine,
    );
    const primaryRoute = routedPrimary ?? this.resolveDefaultRoute(primaryEngine);
    const enginesToTry = expandFallbackChain(this.config, primaryEngine);

    const routingTrace = createRoutingTrace({
      requestedModel: options.model,
      requestedEngine: options.engine,
      primary: primaryRoute,
      fallbackChain: enginesToTry,
    });

    this.log.info('routing', `Routing session "${options.name}": primary=${primaryEngine}, chain=[${enginesToTry.join(',')}]`, {
      session: options.name,
      engine: primaryEngine,
      meta: { requestedModel: options.model, requestedEngine: options.engine },
    });

    let lastError: unknown;
    for (let index = 0; index < enginesToTry.length; index++) {
      const engine = enginesToTry[index]!;
      const route =
        index === 0 ? primaryRoute : this.resolveDefaultRoute(engine);

      // Circuit breaker: skip engines with open circuit
      if (!this.circuitBreaker.isAllowed(engine)) {
        this.log.warn('fallback', `Circuit breaker OPEN for ${engine}, skipping`, {
          session: options.name,
          engine,
          meta: { circuitState: 'open' },
        });
        appendRoutingAttempt(
          routingTrace,
          toRoutingAttempt({ engine, model: route.model, error: new Error('circuit breaker open') }),
        );
        continue;
      }

      try {
        await this.start(options.name, engine, {
          cwd: options.cwd,
          model: route.model,
          resumeSessionId: index === 0 ? options.resumeSessionId : undefined,
        });

        this.circuitBreaker.recordSuccess(engine);

        const record = this.requireSession(options.name);
        record.routingTrace = appendRoutingAttempt(
          routingTrace,
          toRoutingAttempt({ engine, model: route.model }),
        );
        record.role = options.role;

        const info = this.requireSessionInfo(options.name);
        this.store.upsert(info);
        this.emit('session_started', options.name, engine);
        this.log.info('session', `Session "${options.name}" started on ${engine}/${route.model}`, {
          session: options.name,
          engine,
          meta: { role: options.role },
        });

        // Inject system prompt if role has one
        if (role?.systemPrompt) {
          try {
            await this.send(options.name, role.systemPrompt);
            this.emit('system_prompt_injected', options.name, engine, {
              preview: `[${role.id}] system prompt`,
            });
            this.log.info('orchestration', `System prompt injected for role "${role.id}" in session "${options.name}"`, {
              session: options.name,
              engine,
            });
            // Refresh info after prompt injection to capture updated token/cost
            const refreshed = this.requireSessionInfo(options.name);
            this.store.upsert(refreshed);
            return refreshed;
          } catch (promptError) {
            const errMsg = promptError instanceof Error ? promptError.message : String(promptError);
            this.log.warn('orchestration', `System prompt injection failed for "${options.name}": ${errMsg}`, {
              session: options.name,
              engine,
            });
            // Session remains active — system prompt failure is non-fatal
          }
        }

        return info;
      } catch (error) {
        this.circuitBreaker.recordFailure(engine);

        const errMsg = error instanceof Error ? error.message : String(error);
        const errorCategory = error instanceof EngineError ? error.category : 'unknown';
        const circuitState = this.circuitBreaker.getSnapshot(engine).state;
        this.log.warn('fallback', `Engine ${engine} failed for "${options.name}" [${errorCategory}]: ${errMsg}`, {
          session: options.name,
          engine,
          meta: { attempt: index + 1, model: route.model, errorCategory, circuitState },
        });
        appendRoutingAttempt(
          routingTrace,
          toRoutingAttempt({ engine, model: route.model, error }),
        );
        lastError = error;
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new Error(
      `Failed to start session "${options.name}" after trying engines: ${enginesToTry.join(', ')}.`,
    );
  }

  async sendMessage(
    name: string,
    message: string,
    onChunk?: (chunk: string) => void,
  ): Promise<SendMessageResult> {
    validateSessionName(name);
    const release = await this.mutex.acquire(name);
    try {
      return await this.sendMessageInner(name, message, onChunk);
    } finally {
      release();
    }
  }

  private async sendMessageInner(
    name: string,
    message: string,
    onChunk?: (chunk: string) => void,
  ): Promise<SendMessageResult> {
    const record = this.requireSession(name);
    const prevCost = record.session.costUsd;
    const prevTokens = { ...record.session.tokenCount };
    const startMs = Date.now();

    record.phase = 'sending';
    record.updatedAt = startMs;
    this.emit('message_sent', name, record.session.engine, { preview: truncatePreview(message) ?? undefined });

    let output: string;
    try {
      output = await this.send(name, message, onChunk);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log.error('engine', `Send failed for "${name}": ${errMsg}`, { session: name, engine: record.session.engine });
      this.emit('message_failed', name, record.session.engine, {
        error: errMsg,
      });
      // Record failure for adaptive routing
      try {
        const category = classifyTask(message).primary;
        this.adaptiveRouter.recordOutcome(record.session.engine, category, false);
      } catch { /* non-fatal */ }
      throw error;
    }

    const now = Date.now();
    record.phase = 'idle';
    record.lastAction = 'send';
    record.updatedAt = now;
    record.lastPromptPreview = truncatePreview(message);
    record.lastResponsePreview = truncatePreview(output);
    record.turnCount += 1;
    this.emit('message_completed', name, record.session.engine);

    const session = this.requireSessionInfo(name);
    const durationMs = now - startMs;

    const tokensIn = Math.max(0, session.tokenCount.input - prevTokens.input);
    const tokensOut = Math.max(0, session.tokenCount.output - prevTokens.output);
    const cachedTokens = Math.max(0, session.tokenCount.cachedInput - prevTokens.cachedInput);

    // Record success for adaptive routing
    try {
      const category = classifyTask(message).primary;
      this.adaptiveRouter.recordOutcome(record.session.engine, category, true);
    } catch { /* non-fatal */ }

    return {
      name,
      output,
      session,
      turnUsage: {
        tokensIn,
        tokensOut,
        cachedTokens,
        totalTokens: tokensIn + tokensOut + cachedTokens,
        costUsd: roundUsd(Math.max(0, session.costUsd - prevCost)),
        durationMs,
      },
    };
  }

  async stopSession(name: string): Promise<void> {
    validateSessionName(name);
    const release = await this.mutex.acquire(name);
    try {
      await this.stop(name);
    } finally {
      release();
    }
  }

  cancelSession(name: string): SessionInfo {
    validateSessionName(name);
    const record = this.sessions.get(name);
    if (!record) {
      throw new Error(`Session "${name}" not found.`);
    }

    record.engineInstance.cancel();
    record.phase = 'idle';
    record.updatedAt = Date.now();
    syncSession(record);
    this.log.info('session', `Cancelled in-flight operation for "${name}"`, { session: name, engine: record.session.engine });
    return this.requireSessionInfo(name);
  }

  listSessions(): SessionInfo[] {
    this.cleanupExpiredSessions();

    const inMemory = Array.from(this.sessions.entries()).map(([name, record]) => {
      syncSession(record);
      return toSessionInfo(name, record);
    });

    const persisted = this.store.list().filter(
      (session) => !this.sessions.has(session.name),
    );

    return [...inMemory, ...persisted];
  }

  getSessionStatus(name: string): SessionInfo | undefined {
    this.cleanupExpiredSessions();

    const record = this.sessions.get(name);
    if (!record) {
      return this.store.get(name);
    }

    syncSession(record);
    const info = toSessionInfo(name, record);
    this.store.upsert(info);
    return info;
  }

  getOverview(): SessionOverview {
    const sessions = this.listSessions();
    const byEngine = createEmptyBreakdownMap();
    let activeSessions = 0;
    let stoppedSessions = 0;
    let expiredSessions = 0;
    let errorSessions = 0;

    for (const session of sessions) {
      const engineBreakdown = byEngine[session.engine];
      engineBreakdown.sessionCount += 1;
      engineBreakdown.costUsd = roundUsd(
        engineBreakdown.costUsd + session.costUsd,
      );
      engineBreakdown.tokenCount = mergeTokenUsage(
        engineBreakdown.tokenCount,
        session.tokenCount,
      );

      switch (session.status) {
        case 'active':
          activeSessions += 1;
          break;
        case 'stopped':
          stoppedSessions += 1;
          break;
        case 'expired':
          expiredSessions += 1;
          break;
        case 'error':
          errorSessions += 1;
          break;
        default:
          break;
      }
    }

    const totalCostUsd = roundUsd(
      Object.values(byEngine).reduce(
        (sum, breakdown) => sum + breakdown.costUsd,
        0,
      ),
    );

    const sessionSummaries: SessionSummary[] = sessions.map((s) => ({
      name: s.name,
      engine: s.engine,
      model: s.model,
      status: s.status,
      phase: s.activity.phase,
      costUsd: s.costUsd,
      turnCount: s.turnCount,
      lastAction: s.activity.lastAction,
      updatedAt: s.activity.updatedAt,
    }));

    return {
      totalSessions: sessions.length,
      activeSessions,
      stoppedSessions,
      expiredSessions,
      errorSessions,
      totalCostUsd,
      byEngine,
      sessions: sessionSummaries,
    };
  }

  getCostReport(since?: string): CostReport {
    this.cleanupExpiredSessions();

    const sinceDate = since ? this.parseSinceDate(since) : null;
    const byEngine = createEmptyBreakdownMap();

    for (const session of this.listSessions()) {
      if (sinceDate && session.createdAt < sinceDate) {
        continue;
      }

      const engineBreakdown = byEngine[session.engine];
      engineBreakdown.sessionCount += 1;
      engineBreakdown.costUsd = roundUsd(
        engineBreakdown.costUsd + session.costUsd,
      );
      engineBreakdown.tokenCount = mergeTokenUsage(
        engineBreakdown.tokenCount,
        session.tokenCount,
      );
    }

    const trackedUsd = roundUsd(
      Object.values(byEngine).reduce(
        (sum, breakdown) => sum + breakdown.costUsd,
        0,
      ),
    );
    const subscriptionSaved = roundUsd(byEngine.claude.costUsd);

    return {
      since: sinceDate?.toISOString() ?? null,
      totalUsd: roundUsd(trackedUsd - subscriptionSaved),
      trackedUsd,
      byEngine,
      subscriptionSaved,
    };
  }

  resolveModelRoute(model: string, preferredEngine?: EngineKind) {
    return resolveModelRoute(
      this.config,
      (engine) => this.getEngineDefaults(engine),
      (engine) => this.getFallbackModel(engine),
      model,
      preferredEngine,
    );
  }

  async compactSession(
    name: string,
    summary?: string,
  ): Promise<SendMessageResult> {
    validateSessionName(name);
    const release = await this.mutex.acquire(name);
    try {
      return await this.compactSessionInner(name, summary);
    } finally {
      release();
    }
  }

  private async compactSessionInner(
    name: string,
    summary?: string,
  ): Promise<SendMessageResult> {
    this.cleanupExpiredSessions();

    const record = this.requireSession(name);
    const prevCost = record.session.costUsd;
    const prevTokens = { ...record.session.tokenCount };
    const startMs = Date.now();

    record.phase = 'compacting';
    record.updatedAt = startMs;
    this.emit('compact_started', name, record.session.engine);

    try {
      const output = await record.engineInstance.compact(summary);
      const now = Date.now();
      record.lastTouchedAt = now;
      record.phase = 'idle';
      record.lastAction = 'compact';
      record.updatedAt = now;
      record.lastResponsePreview = truncatePreview(output);
      this.emit('compact_completed', name, record.session.engine);
      syncSession(record);

      const session = this.requireSessionInfo(name);
      const durationMs = now - startMs;

      const tokensIn = Math.max(0, session.tokenCount.input - prevTokens.input);
      const tokensOut = Math.max(0, session.tokenCount.output - prevTokens.output);
      const cachedTokens = Math.max(0, session.tokenCount.cachedInput - prevTokens.cachedInput);

      return {
        name,
        output,
        session,
        turnUsage: {
          tokensIn,
          tokensOut,
          cachedTokens,
          totalTokens: tokensIn + tokensOut + cachedTokens,
          costUsd: roundUsd(Math.max(0, session.costUsd - prevCost)),
          durationMs,
        },
      };
    } catch (error) {
      record.lastTouchedAt = Date.now();
      record.phase = 'idle';
      record.updatedAt = Date.now();
      syncSession(record);
      throw this.wrapSessionError('compact', name, record.session.engine, error);
    }
  }

  async shutdown(): Promise<void> {
    await this.dispose();
  }

  async start(
    name: string,
    engine: EngineKind,
    config: Partial<EngineConfig> = {},
  ): Promise<ISession> {
    this.cleanupExpiredSessions();
    validateSessionName(name);

    const existing = this.sessions.get(name);
    if (existing?.session.status === 'active') {
      throw new Error(`Session "${name}" is already active.`);
    }

    if (existing) {
      this.sessions.delete(name);
      void existing.engineInstance.stop().catch(() => {
        // Replaced sessions are stopped on a best-effort basis.
      });
    }

    this.enforceConcurrentSessionLimit();

    const resolvedConfig = this.resolveEngineConfig(engine, config);
    const engineInstance = createEngine(engine, resolvedConfig);

    try {
      await engineInstance.start();
    } catch (error) {
      void engineInstance.stop().catch(() => {
        // Best-effort cleanup after a failed start so fallback can proceed cleanly.
      });
      throw this.wrapSessionError('start', name, engine, error);
    }

    const now = Date.now();
    const session: ISession = {
      id: crypto.randomUUID(),
      engine,
      model: resolvedConfig.model,
      status: 'active',
      createdAt: new Date(now),
      costUsd: 0,
      tokenCount: emptyTokenUsage(),
    };

    const record: SessionRecord = {
      engineInstance,
      session,
      config: resolvedConfig,
      lastTouchedAt: now,
      phase: 'idle',
      lastAction: 'start',
      updatedAt: now,
      lastPromptPreview: null,
      lastResponsePreview: null,
      isRehydrated: false,
      turnCount: 0,
    };

    syncSession(record);
    this.sessions.set(name, record);

    return cloneSession(record.session);
  }

  async send(name: string, message: string, onChunk?: (chunk: string) => void): Promise<string> {
    this.cleanupExpiredSessions();

    let record = this.sessions.get(name);
    if (!record) {
      const persisted = this.store.get(name);
      if (!persisted) {
        throw new Error(`Session "${name}" not found.`);
      }
      record = await this.rehydrateSession(persisted);
    }

    if (record.session.status !== 'active') {
      throw new Error(`Session "${name}" is not active.`);
    }

    try {
      const response = await record.engineInstance.send(message, onChunk);
      record.lastTouchedAt = Date.now();
      syncSession(record);
      this.store.upsert(this.requireSessionInfo(name));
      return response;
    } catch (error) {
      record.lastTouchedAt = Date.now();
      syncSession(record);
      this.store.upsert(this.requireSessionInfo(name));
      throw this.wrapSessionError('send', name, record.session.engine, error);
    }
  }

  async stop(name: string): Promise<void> {
    this.cleanupExpiredSessions();

    const record = this.sessions.get(name);
    if (!record) {
      this.store.delete(name);
      return;
    }

    record.phase = 'stopping';
    record.updatedAt = Date.now();

    try {
      await record.engineInstance.stop();
      const now = Date.now();
      record.lastTouchedAt = now;
      record.phase = 'stopped';
      record.lastAction = 'stop';
      record.updatedAt = now;
      syncSession(record);
      this.sessions.delete(name);
      this.store.delete(name);
      this.emit('session_stopped', name, record.session.engine);
      this.log.info('session', `Session "${name}" stopped`, { session: name, engine: record.session.engine });

      // Release a waiting session from the queue if any
      if (this.sessionQueue.hasWaiters) {
        this.sessionQueue.release();
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log.error('session', `Failed to stop session "${name}": ${errMsg}`, { session: name, engine: record.session.engine });
      record.lastTouchedAt = Date.now();
      record.phase = 'idle';
      record.updatedAt = Date.now();
      syncSession(record);
      this.store.upsert(this.requireSessionInfo(name));
      throw this.wrapSessionError('stop', name, record.session.engine, error);
    }
  }

  list(): ISession[] {
    this.cleanupExpiredSessions();

    return Array.from(this.sessions.values()).map((record) => {
      syncSession(record);
      return cloneSession(record.session);
    });
  }

  status(name: string): ISession | undefined {
    this.cleanupExpiredSessions();

    const record = this.sessions.get(name);
    if (!record) {
      return undefined;
    }

    syncSession(record);
    return cloneSession(record.session);
  }

  async dispose(): Promise<void> {
    this.healthChecker.stop();
    this.sessionQueue.rejectAll('SessionManager is shutting down.');
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer as unknown as number);
      this.cleanupTimer = null;
    }

    const records = Array.from(this.sessions.values());
    this.sessions.clear();

    await Promise.allSettled(
      records.map((record) => record.engineInstance.stop()),
    );
  }

  private cleanupExpiredSessions(): void {
    const ttlMs = this.config.ttlMs ?? DEFAULT_TTL_MS;
    const now = Date.now();

    // Clean up in-memory sessions
    const expiredSessionNames = cleanupExpiredSessions(this.sessions, ttlMs, now);
    for (const name of expiredSessionNames) {
      this.store.delete(name);
      this.log.info('expiry', `Expired in-memory session "${name}"`, { session: name });
    }

    // Clean up persisted sessions that expired while plugin was offline
    const persisted = this.store.list();
    for (const session of persisted) {
      if (this.sessions.has(session.name)) continue;
      if (now - session.lastTouchedAt.getTime() >= ttlMs) {
        this.store.delete(session.name);
        this.events.clearEvents(session.name);
        this.log.info('expiry', `Purged persisted expired session "${session.name}"`, { session: session.name, engine: session.engine });
      }
    }
  }

  private isAtSessionLimit(): boolean {
    const maxConcurrentSessions =
      this.config.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
    const activeSessions = Array.from(this.sessions.values()).filter(
      (record) => record.session.status === 'active',
    );
    return activeSessions.length >= maxConcurrentSessions;
  }

  private enforceConcurrentSessionLimit(): void {
    if (this.isAtSessionLimit()) {
      const maxConcurrentSessions =
        this.config.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
      throw new Error(
        `Maximum concurrent session limit reached (${maxConcurrentSessions}).`,
      );
    }
  }

  /**
   * Wait in the backpressure queue until a session slot is available.
   * If already under the limit, returns immediately.
   */
  async waitForSlot(sessionName: string, priority: QueuePriority = 'normal'): Promise<void> {
    if (!this.isAtSessionLimit()) return;

    this.log.info('orchestration', `Session "${sessionName}" waiting in queue (priority: ${priority})`, {
      session: sessionName,
      meta: { queueDepth: this.sessionQueue.depth, priority },
    });

    await this.sessionQueue.enqueue(sessionName, priority);

    this.log.info('orchestration', `Session "${sessionName}" released from queue`, {
      session: sessionName,
    });
  }

  getQueueSnapshot(): QueueSnapshot {
    return this.sessionQueue.getSnapshot();
  }

  private resolveEngineConfig(
    engine: EngineKind,
    config: Partial<EngineConfig>,
  ): EngineConfig {
    const defaults = this.getEngineDefaults(engine);
    const merged = mergeEngineConfig(
      {
        command: defaults.command,
        args: defaults.args ?? [],
        env: defaults.env,
        model: defaults.model ?? '',
        cwd: defaults.cwd ?? this.config.defaultCwd,
        resumeSessionId: defaults.resumeSessionId,
        timeoutMs: defaults.timeoutMs,
        apiKey: defaults.apiKey,
        baseUrl: defaults.baseUrl,
        pricing: defaults.pricing,
      },
      config,
    );

    merged.cwd ??= this.config.defaultCwd;

    if (!merged.model) {
      throw new Error(`Model is required to start a ${engine} session.`);
    }

    return merged;
  }

  private getEngineDefaults(engine: EngineKind): Partial<EngineConfig> {
    switch (engine) {
      case 'claude':
        return this.config.claude ?? {};
      case 'codex':
        return this.config.codex ?? {};
      case 'grok':
        return this.config.grok ?? {};
      case 'ollama':
        return this.config.ollama ?? {};
      default: {
        const exhaustiveCheck: never = engine;
        throw new Error(`Unsupported engine: ${exhaustiveCheck}`);
      }
    }
  }

  private requireSession(name: string): SessionRecord {
    const record = this.sessions.get(name);
    if (!record) {
      throw new Error(`Session "${name}" not found.`);
    }

    return record;
  }

  private async rehydrateSession(session: SessionInfo): Promise<SessionRecord> {
    if (this.rehydrating.has(session.name)) {
      this.log.warn('rehydration', `Rehydration already in progress for "${session.name}", rejecting duplicate`, { session: session.name, engine: session.engine });
      throw new Error(`Rehydration already in progress for session "${session.name}".`);
    }
    this.rehydrating.add(session.name);
    this.log.info('rehydration', `Rehydrating session "${session.name}" on ${session.engine}`, { session: session.name, engine: session.engine });
    try {
      const record = await this.rehydrateSessionInner(session);
      this.log.info('rehydration', `Session "${session.name}" rehydrated successfully`, { session: session.name, engine: session.engine });
      return record;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log.error('rehydration', `Failed to rehydrate "${session.name}": ${errMsg}`, { session: session.name, engine: session.engine });
      throw error;
    } finally {
      this.rehydrating.delete(session.name);
    }
  }

  private async rehydrateSessionInner(session: SessionInfo): Promise<SessionRecord> {
    const resolvedConfig = this.resolveEngineConfig(session.engine, {
      model: session.model,
      cwd: session.cwd ?? undefined,
      resumeSessionId: session.engineSessionId ?? undefined,
    });
    const engineInstance = createEngine(session.engine, resolvedConfig);

    try {
      await engineInstance.start({
        model: session.model,
        cwd: session.cwd ?? undefined,
        resumeSessionId: session.engineSessionId ?? undefined,
      });
    } catch (error) {
      throw this.wrapSessionError('rehydrate', session.name, session.engine, error);
    }

    const now = Date.now();
    const record: SessionRecord = {
      engineInstance,
      session: {
        id: session.id,
        engine: session.engine,
        model: session.model,
        status: session.status,
        createdAt: new Date(session.createdAt),
        costUsd: session.costUsd,
        tokenCount: { ...session.tokenCount },
      },
      config: resolvedConfig,
      lastTouchedAt: session.lastTouchedAt.getTime(),
      routingTrace: session.routingTrace,
      phase: 'idle',
      lastAction: 'rehydrate',
      updatedAt: now,
      lastPromptPreview: session.activity.lastPromptPreview,
      lastResponsePreview: session.activity.lastResponsePreview,
      isRehydrated: true,
      turnCount: session.turnCount,
      role: session.role,
    };

    syncSession(record);
    this.sessions.set(session.name, record);
    this.emit('session_rehydrated', session.name, session.engine);
    return record;
  }

  private requireSessionInfo(name: string): SessionInfo {
    const session = this.getSessionStatus(name);
    if (!session) {
      throw new Error(`Session "${name}" not found.`);
    }

    return session;
  }

  private resolveDefaultRoute(preferredEngine?: EngineKind) {
    return resolveDefaultRoute(
      this.config,
      (engine) => this.getEngineDefaults(engine),
      (engine) => this.getFallbackModel(engine),
      preferredEngine,
    );
  }

  private getFallbackModel(engine: EngineKind): string {
    switch (engine) {
      case 'claude':
        return 'claude-opus-4-6';
      case 'codex':
        return 'gpt-5.4';
      case 'grok':
        return 'grok-4-1-fast';
      case 'ollama':
        return 'gemma4';
      default: {
        const exhaustiveCheck: never = engine;
        throw new Error(`Unsupported engine: ${exhaustiveCheck}`);
      }
    }
  }

  private parseSinceDate(value: string): Date {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid "since" value: "${value}".`);
    }

    return date;
  }

  private emit(
    type: SessionEvent['type'],
    name: string,
    engine: EngineKind,
    extra?: { preview?: string; error?: string },
  ): void {
    this.events.appendEvent({
      ts: new Date().toISOString(),
      type,
      engine,
      sessionName: name,
      ...extra,
    });
  }

  /* ── Health check operations ────────────────────────────────── */

  startHealthChecks(): void {
    this.healthChecker.start();
    this.log.info('orchestration', 'Health checks started');
  }

  stopHealthChecks(): void {
    this.healthChecker.stop();
  }

  async runHealthCheck(engine?: EngineKind): Promise<HealthCheckResult[]> {
    if (engine) {
      const result = await this.healthChecker.check(engine);
      return [result];
    }
    return this.healthChecker.checkAll();
  }

  getHealthResults(): HealthCheckResult[] {
    return this.healthChecker.getAllResults();
  }

  /* ── Circuit breaker operations ─────────────────────────────── */

  getCircuitState(engine: EngineKind): CircuitSnapshot {
    return this.circuitBreaker.getSnapshot(engine);
  }

  getAllCircuitStates(): CircuitSnapshot[] {
    return this.circuitBreaker.getAllSnapshots();
  }

  resetCircuit(engine: EngineKind): void {
    this.circuitBreaker.reset(engine);
    this.log.info('orchestration', `Circuit breaker reset for ${engine}`, { engine });
  }

  /* ── Adaptive routing operations ─────────────────────────────── */

  persistRoutingStats(): void {
    try {
      this.routingStatsStore.save(this.adaptiveRouter.exportStats());
    } catch { /* non-fatal */ }
  }

  getAdaptiveRoutingStats(engine?: EngineKind, category?: string): RoutingStats[] {
    return this.adaptiveRouter.getStats(engine, category);
  }

  setRoutingStrategy(strategy: RoutingStrategy): void {
    this.adaptiveRouter.strategy = strategy;
    this.log.info('routing', `Routing strategy set to "${strategy}"`, {});
  }

  getRoutingStrategy(): RoutingStrategy {
    return this.adaptiveRouter.strategy;
  }

  /* ── Workflow operations ────────────────────────────────────── */

  async startWorkflow(definition: WorkflowDefinition): Promise<WorkflowState> {
    this.log.info('orchestration', `Starting workflow "${definition.id}" with ${definition.steps.length} steps`, {
      meta: { workflowId: definition.id, workspace: definition.workspace },
    });
    return this.workflows.start(definition, this);
  }

  getWorkflowStatus(id: string): WorkflowState | undefined {
    return this.workflows.getStatus(id);
  }

  async resumeWorkflow(id: string): Promise<WorkflowState> {
    this.log.info('orchestration', `Resuming workflow "${id}"`, {
      meta: { workflowId: id },
    });
    return this.workflows.resume(id, this);
  }

  listInterruptedWorkflows(): WorkflowState[] {
    return this.workflows.listInterrupted();
  }

  cancelWorkflow(id: string): WorkflowState {
    this.log.info('orchestration', `Cancelling workflow "${id}"`, {
      meta: { workflowId: id },
    });
    return this.workflows.cancel(id);
  }

  listWorkflows(): WorkflowState[] {
    return this.workflows.list();
  }

  /* ── Relay operations ───────────────────────────────────────── */

  async relayMessage(
    from: string,
    to: string,
    message: string,
    onChunk?: (chunk: string) => void,
  ): Promise<RelayResult> {
    validateSessionName(from);
    validateSessionName(to);

    // Validate source session exists
    const fromRecord = this.sessions.get(from);
    if (!fromRecord) {
      const persisted = this.store.get(from);
      if (!persisted) throw new Error(`Source session "${from}" not found.`);
    }

    // Send to target (sendMessage handles its own validation and mutex)
    const sendResult = await this.sendMessage(to, message, onChunk);

    // Emit relay events on both session timelines
    const toRecord = this.requireSession(to);
    this.emit('message_relayed', from, fromRecord?.session.engine ?? toRecord.session.engine, {
      preview: `relay → ${to}`,
    });
    this.emit('message_relayed', to, toRecord.session.engine, {
      preview: `relay ← ${from}`,
    });

    this.log.info('orchestration', `Relayed message from "${from}" to "${to}"`, {
      session: to,
      engine: toRecord.session.engine,
      meta: { from, to },
    });

    return { from, to, message, sendResult };
  }

  async broadcastMessage(
    from: string,
    message: string,
    exclude?: string[],
  ): Promise<BroadcastResult> {
    validateSessionName(from);

    const excludeSet = new Set(exclude ?? []);
    excludeSet.add(from);

    const activeSessions = this.listSessions().filter(
      (s) => s.status === 'active' && !excludeSet.has(s.name),
    );
    const targets = activeSessions.map((s) => s.name);

    const settled = await Promise.allSettled(
      targets.map(async (to): Promise<BroadcastTargetResult> => {
        try {
          const sendResult = await this.sendMessage(to, message);
          return { to, ok: true, sendResult };
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          return { to, ok: false, error: errMsg };
        }
      }),
    );

    const results: BroadcastTargetResult[] = settled.map((s) =>
      s.status === 'fulfilled'
        ? s.value
        : { to: 'unknown', ok: false, error: s.reason instanceof Error ? s.reason.message : String(s.reason) },
    );

    this.log.info('orchestration', `Broadcast from "${from}" to ${targets.length} sessions`, {
      meta: { from, targets, successCount: results.filter(r => r.ok).length },
    });

    return { from, targets, message, results };
  }

  /* ── Role operations ────────────────────────────────────────── */

  registerRole(role: AgentRole): void {
    this.roles.register(role);
    this.roleStore.upsert(role);
    this.log.info('orchestration', `Custom role "${role.id}" registered`, {
      meta: { roleId: role.id },
    });
  }

  /* ── Context (Blackboard) operations ──────────────────────────── */

  async setContext(
    workspace: string,
    key: string,
    value: unknown,
    setBy: string,
  ): Promise<ContextEntry> {
    const release = await this.mutex.acquire(`ctx::${workspace}`);
    try {
      const entry = this.context.set(workspace, key, value, setBy);
      this.contextEvents.appendEvent({
        ts: new Date().toISOString(),
        type: 'context_set',
        workspace,
        key,
        setBy,
      });
      this.log.info('context', `Context "${key}" set in workspace "${workspace}" by "${setBy}"`, {
        meta: { workspace, key, setBy },
      });
      return entry;
    } finally {
      release();
    }
  }

  getContext(workspace: string, key: string): ContextEntry | undefined {
    return this.context.get(workspace, key);
  }

  listContext(workspace: string): ContextEntry[] {
    return this.context.list(workspace);
  }

  async clearContext(workspace: string, clearedBy: string): Promise<void> {
    const release = await this.mutex.acquire(`ctx::${workspace}`);
    try {
      this.context.clear(workspace);
      this.contextEvents.appendEvent({
        ts: new Date().toISOString(),
        type: 'context_cleared',
        workspace,
        setBy: clearedBy,
      });
      this.log.info('context', `Context cleared for workspace "${workspace}" by "${clearedBy}"`, {
        meta: { workspace, clearedBy },
      });
    } finally {
      release();
    }
  }

  private wrapSessionError(
    action: 'start' | 'send' | 'stop' | 'compact' | 'rehydrate',
    name: string,
    engine: EngineKind,
    error: unknown,
  ): Error {
    if (error instanceof EngineError) {
      const wrapped = new EngineError(
        `Failed to ${action} ${engine} session "${name}": ${error.message}`,
        error.category,
        {
          cause: error,
          httpStatus: error.httpStatus,
          retriable: error.retriable,
          retryAfterMs: error.retryAfterMs,
        },
      );
      return wrapped;
    }

    const message = error instanceof Error ? error.message : String(error);
    return new Error(
      `Failed to ${action} ${engine} session "${name}": ${message}`,
    );
  }

}

const PREVIEW_MAX_LENGTH = 120;

function truncatePreview(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length <= PREVIEW_MAX_LENGTH) return trimmed;
  return trimmed.slice(0, PREVIEW_MAX_LENGTH) + '…';
}
