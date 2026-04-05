import { createEngine } from './engines/create-engine.js';
import {
  emptyTokenUsage,
  mergeEngineConfig,
  mergeTokenUsage,
  roundUsd,
} from './engines/shared.js';
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
  TokenUsage,
  TurnUsage,
} from './types.js';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_SESSIONS = 8;

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly config: SentinelBridgeConfig;
  private readonly store = new SessionStore();
  readonly events = new SessionEventStore();
  private cleanupTimer: {
    unref?: () => void;
  } | null = null;

  constructor(config: SentinelBridgeConfig = {}) {
    this.config = config;

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

  async startSession(options: SessionStartOptions): Promise<SessionInfo> {
    const routedPrimary = options.model
      ? this.resolveModelRoute(options.model, options.engine)
      : undefined;
    const primaryEngine = selectPrimaryEngine(
      this.config,
      options,
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

    let lastError: unknown;
    for (let index = 0; index < enginesToTry.length; index++) {
      const engine = enginesToTry[index]!;
      const route =
        index === 0 ? primaryRoute : this.resolveDefaultRoute(engine);

      try {
        await this.start(options.name, engine, {
          cwd: options.cwd,
          model: route.model,
          resumeSessionId: index === 0 ? options.resumeSessionId : undefined,
        });

        const record = this.requireSession(options.name);
        record.routingTrace = appendRoutingAttempt(
          routingTrace,
          toRoutingAttempt({ engine, model: route.model }),
        );

        const info = this.requireSessionInfo(options.name);
        this.store.upsert(info);
        this.emit('session_started', options.name, engine);
        return info;
      } catch (error) {
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

  async sendMessage(name: string, message: string): Promise<SendMessageResult> {
    const record = this.requireSession(name);
    const prevCost = record.session.costUsd;
    const prevTokens = { ...record.session.tokenCount };
    const startMs = Date.now();

    record.phase = 'sending';
    record.updatedAt = startMs;
    this.emit('message_sent', name, record.session.engine, { preview: truncatePreview(message) ?? undefined });

    let output: string;
    try {
      output = await this.send(name, message);
    } catch (error) {
      this.emit('message_failed', name, record.session.engine, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const now = Date.now();
    record.phase = 'idle';
    record.lastAction = 'send';
    record.updatedAt = now;
    record.lastPromptPreview = truncatePreview(message);
    record.lastResponsePreview = truncatePreview(output);
    this.emit('message_completed', name, record.session.engine);

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
  }

  async stopSession(name: string): Promise<void> {
    await this.stop(name);
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

    return {
      totalSessions: sessions.length,
      activeSessions,
      stoppedSessions,
      expiredSessions,
      errorSessions,
      totalCostUsd,
      byEngine,
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

    if (!name.trim()) {
      throw new Error('Session name is required.');
    }

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
    };

    syncSession(record);
    this.sessions.set(name, record);

    return cloneSession(record.session);
  }

  async send(name: string, message: string): Promise<string> {
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
      const response = await record.engineInstance.send(message);
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
    } catch (error) {
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
    cleanupExpiredSessions(this.sessions, ttlMs);
  }

  private enforceConcurrentSessionLimit(): void {
    const maxConcurrentSessions =
      this.config.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
    const activeSessions = Array.from(this.sessions.values()).filter(
      (record) => record.session.status === 'active',
    );

    if (activeSessions.length >= maxConcurrentSessions) {
      throw new Error(
        `Maximum concurrent session limit reached (${maxConcurrentSessions}).`,
      );
    }
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

  private wrapSessionError(
    action: 'start' | 'send' | 'stop' | 'compact' | 'rehydrate',
    name: string,
    engine: EngineKind,
    error: unknown,
  ): Error {
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
