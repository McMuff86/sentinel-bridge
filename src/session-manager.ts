import { ClaudeEngine } from './engines/claude-engine.js';
import { CodexEngine } from './engines/codex-engine.js';
import { GrokEngine } from './engines/grok-engine.js';
import {
  emptyTokenUsage,
  mergeEngineConfig,
  mergeTokenUsage,
  roundUsd,
} from './engines/shared.js';
import type {
  CostReport,
  EngineConfig,
  EngineCostBreakdown,
  EngineKind,
  IEngine,
  ISession,
  ModelRoute,
  SentinelBridgeConfig,
  SendMessageResult,
  SessionInfo,
  SessionOverview,
  SessionStartOptions,
  TokenUsage,
} from './types.js';

interface SessionRecord {
  engineInstance: IEngine;
  session: ISession;
  config: EngineConfig;
  lastTouchedAt: number;
}

type ParsedModelReference = {
  engine?: EngineKind;
  model: string;
};

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_SESSIONS = 8;

const DEFAULT_FALLBACK_CHAIN: EngineKind[] = ['claude', 'codex', 'grok'];

const MODEL_ALIASES: Record<EngineKind, Record<string, string>> = {
  claude: {
    opus: 'claude-opus-4-6',
    'opus-4.6': 'claude-opus-4-6',
    'claude-opus-4': 'claude-opus-4-6',
    sonnet: 'claude-sonnet-4',
    'claude-sonnet-4': 'claude-sonnet-4',
    haiku: 'claude-haiku-4',
    'claude-haiku-4': 'claude-haiku-4',
  },
  codex: {
    codex: 'gpt-5.4',
    'gpt-5.4': 'gpt-5.4',
    'gpt-5': 'gpt-5.4',
    'o4-mini': 'o4-mini',
    'codex-mini': 'codex-mini',
  },
  grok: {
    grok: 'grok-4-1-fast',
    'grok-4': 'grok-4',
    'grok-4-fast': 'grok-4-fast',
    'grok-4-1-fast': 'grok-4-1-fast',
    '4-1-fast': 'grok-4-1-fast',
    'grok-3': 'grok-3',
    'grok-mini': 'grok-3-mini',
    'grok-3-mini': 'grok-3-mini',
  },
};

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly config: SentinelBridgeConfig;
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
    const primaryRoute = options.model
      ? this.resolveModelRoute(options.model, options.engine)
      : this.resolveDefaultRoute(options.engine);
    const primaryEngine = options.engine ?? primaryRoute.engine;
    const enginesToTry = this.expandFallbackChain(primaryEngine);

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

        return this.requireSessionInfo(options.name);
      } catch (error) {
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
    const output = await this.send(name, message);

    return {
      name,
      output,
      session: this.requireSessionInfo(name),
    };
  }

  async stopSession(name: string): Promise<void> {
    await this.stop(name);
  }

  listSessions(): SessionInfo[] {
    this.cleanupExpiredSessions();

    return Array.from(this.sessions.entries()).map(([name, record]) => {
      this.syncSession(record);
      return this.toSessionInfo(name, record);
    });
  }

  getSessionStatus(name: string): SessionInfo | undefined {
    this.cleanupExpiredSessions();

    const record = this.sessions.get(name);
    if (!record) {
      return undefined;
    }

    this.syncSession(record);
    return this.toSessionInfo(name, record);
  }

  getOverview(): SessionOverview {
    const sessions = this.listSessions();
    const byEngine = this.createEmptyBreakdownMap();
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
    const byEngine = this.createEmptyBreakdownMap();

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

  resolveModelRoute(
    model: string,
    preferredEngine?: EngineKind,
  ): ModelRoute {
    const trimmedModel = model.trim();
    if (!trimmedModel) {
      return this.resolveDefaultRoute(preferredEngine);
    }

    const parsed = this.parseModelReference(trimmedModel);
    if (
      preferredEngine &&
      parsed.engine &&
      parsed.engine !== preferredEngine
    ) {
      throw new Error(
        `Model "${trimmedModel}" does not match requested engine "${preferredEngine}".`,
      );
    }

    const detectedEngine = parsed.engine ?? this.inferEngineFromModel(parsed.model);
    const engine =
      preferredEngine ??
      detectedEngine ??
      this.config.defaultEngine ??
      'claude';
    const conflictingEngine =
      preferredEngine && !parsed.engine
        ? this.inferEngineFromModel(parsed.model)
        : undefined;

    if (
      preferredEngine &&
      conflictingEngine &&
      conflictingEngine !== preferredEngine &&
      !this.isKnownAliasForEngine(preferredEngine, parsed.model)
    ) {
      throw new Error(
        `Model "${trimmedModel}" does not match requested engine "${preferredEngine}".`,
      );
    }

    const resolvedModel = this.resolveModelAlias(engine, parsed.model);
    const source = resolvedModel === parsed.model ? 'explicit' : 'alias';

    return {
      model: resolvedModel,
      engine,
      subscriptionCovered: engine === 'claude',
      source,
    };
  }

  async compactSession(
    name: string,
    summary?: string,
  ): Promise<SendMessageResult> {
    this.cleanupExpiredSessions();

    const record = this.requireSession(name);

    try {
      const output = await record.engineInstance.compact(summary);
      record.lastTouchedAt = Date.now();
      this.syncSession(record);

      return {
        name,
        output,
        session: this.requireSessionInfo(name),
      };
    } catch (error) {
      record.lastTouchedAt = Date.now();
      this.syncSession(record);
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
    const engineInstance = this.createEngine(engine, resolvedConfig);

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
    };

    this.syncSession(record);
    this.sessions.set(name, record);

    return this.cloneSession(record.session);
  }

  async send(name: string, message: string): Promise<string> {
    this.cleanupExpiredSessions();

    const record = this.requireSession(name);
    if (record.session.status !== 'active') {
      throw new Error(`Session "${name}" is not active.`);
    }

    try {
      const response = await record.engineInstance.send(message);
      record.lastTouchedAt = Date.now();
      this.syncSession(record);
      return response;
    } catch (error) {
      record.lastTouchedAt = Date.now();
      this.syncSession(record);
      throw this.wrapSessionError('send', name, record.session.engine, error);
    }
  }

  async stop(name: string): Promise<void> {
    this.cleanupExpiredSessions();

    const record = this.requireSession(name);

    try {
      await record.engineInstance.stop();
      record.lastTouchedAt = Date.now();
      this.syncSession(record);
    } catch (error) {
      record.lastTouchedAt = Date.now();
      this.syncSession(record);
      throw this.wrapSessionError('stop', name, record.session.engine, error);
    }
  }

  list(): ISession[] {
    this.cleanupExpiredSessions();

    return Array.from(this.sessions.values()).map((record) => {
      this.syncSession(record);
      return this.cloneSession(record.session);
    });
  }

  status(name: string): ISession | undefined {
    this.cleanupExpiredSessions();

    const record = this.sessions.get(name);
    if (!record) {
      return undefined;
    }

    this.syncSession(record);
    return this.cloneSession(record.session);
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
    const now = Date.now();

    for (const [name, record] of this.sessions.entries()) {
      if (now - record.lastTouchedAt < ttlMs) {
        continue;
      }

      record.session.status = 'expired';
      this.sessions.delete(name);
      void record.engineInstance.stop().catch(() => {
        // Expired sessions are best-effort cleaned up in the background.
      });
    }
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

  private createEngine(engine: EngineKind, config: EngineConfig): IEngine {
    switch (engine) {
      case 'claude':
        return new ClaudeEngine(config);
      case 'codex':
        return new CodexEngine(config);
      case 'grok':
        return new GrokEngine(config);
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

  private requireSessionInfo(name: string): SessionInfo {
    const session = this.getSessionStatus(name);
    if (!session) {
      throw new Error(`Session "${name}" not found.`);
    }

    return session;
  }

  private syncSession(record: SessionRecord): void {
    const engineStatus = record.engineInstance.status();

    record.session.model = engineStatus.model || record.session.model;
    record.config.model = record.session.model;
    record.session.costUsd = engineStatus.usage.costUsd;
    record.session.tokenCount = { ...engineStatus.usage.tokenCount };

    if (record.session.status === 'expired') {
      return;
    }

    if (engineStatus.state === 'error') {
      record.session.status = 'error';
      return;
    }

    if (engineStatus.state === 'stopped') {
      record.session.status = 'stopped';
      return;
    }

    record.session.status = 'active';
  }

  private cloneSession(session: ISession): ISession {
    return {
      ...session,
      createdAt: new Date(session.createdAt),
      tokenCount: { ...session.tokenCount },
    };
  }

  private toSessionInfo(name: string, record: SessionRecord): SessionInfo {
    const session = this.cloneSession(record.session);
    const status = record.engineInstance.status();

    return {
      ...session,
      name,
      cwd: record.config.cwd ?? null,
      engineState: status.state,
      engineSessionId: status.sessionId,
      lastTouchedAt: new Date(record.lastTouchedAt),
      lastError: status.usage.lastError,
    };
  }

  private createEmptyBreakdownMap(): Record<EngineKind, EngineCostBreakdown> {
    return {
      claude: this.createEmptyBreakdown(),
      codex: this.createEmptyBreakdown(),
      grok: this.createEmptyBreakdown(),
    };
  }

  private createEmptyBreakdown(): EngineCostBreakdown {
    return {
      sessionCount: 0,
      costUsd: 0,
      tokenCount: emptyTokenUsage(),
    };
  }

  private resolveDefaultRoute(preferredEngine?: EngineKind): ModelRoute {
    const defaultModel = this.config.defaultModel?.trim();
    if (defaultModel) {
      const parsedDefault = this.parseModelReference(defaultModel);
      const defaultEngine =
        parsedDefault.engine ?? this.inferEngineFromModel(parsedDefault.model);

      if (!preferredEngine || !defaultEngine || defaultEngine === preferredEngine) {
        const route = this.resolveModelRoute(defaultModel, preferredEngine);
        return {
          ...route,
          source: 'default',
        };
      }
    }

    const engine = preferredEngine ?? this.config.defaultEngine ?? 'claude';
    const defaults = this.getEngineDefaults(engine);

    return {
      engine,
      model: defaults.model ?? this.getFallbackModel(engine),
      subscriptionCovered: engine === 'claude',
      source: 'default',
    };
  }

  private parseModelReference(model: string): ParsedModelReference {
    const [rawPrefix, ...rest] = model.split('/');
    if (rest.length === 0) {
      return { model };
    }

    const engine = this.parseEngineKind(rawPrefix);
    return {
      engine,
      model: rest.join('/'),
    };
  }

  private parseEngineKind(value: string): EngineKind | undefined {
    switch (value.trim().toLowerCase()) {
      case 'claude':
        return 'claude';
      case 'codex':
      case 'openai':
        return 'codex';
      case 'grok':
      case 'xai':
        return 'grok';
      default:
        return undefined;
    }
  }

  private inferEngineFromModel(model: string): EngineKind | undefined {
    const normalizedModel = model.trim().toLowerCase();

    if (!normalizedModel) {
      return undefined;
    }

    if (
      normalizedModel.startsWith('claude-') ||
      normalizedModel === 'opus' ||
      normalizedModel === 'sonnet' ||
      normalizedModel === 'haiku' ||
      normalizedModel === 'opus-4.6'
    ) {
      return 'claude';
    }

    if (
      normalizedModel.startsWith('grok-') ||
      normalizedModel === 'grok' ||
      normalizedModel === 'grok-mini' ||
      normalizedModel === '4-1-fast'
    ) {
      return 'grok';
    }

    if (
      normalizedModel.startsWith('gpt-') ||
      normalizedModel.startsWith('o4-') ||
      normalizedModel.startsWith('codex-') ||
      normalizedModel === 'codex'
    ) {
      return 'codex';
    }

    return undefined;
  }

  private resolveModelAlias(engine: EngineKind, model: string): string {
    const normalizedModel = model.trim().toLowerCase();
    const alias = MODEL_ALIASES[engine][normalizedModel];

    return alias ?? model.trim();
  }

  private isKnownAliasForEngine(engine: EngineKind, model: string): boolean {
    const normalizedModel = model.trim().toLowerCase();

    return (
      Boolean(MODEL_ALIASES[engine][normalizedModel]) ||
      this.inferEngineFromModel(normalizedModel) === engine
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

  private wrapSessionError(
    action: 'start' | 'send' | 'stop' | 'compact',
    name: string,
    engine: EngineKind,
    error: unknown,
  ): Error {
    const message = error instanceof Error ? error.message : String(error);

    return new Error(
      `Failed to ${action} ${engine} session "${name}": ${message}`,
    );
  }

  /**
   * Primary engine is always first; remaining engines follow plugin order without duplicates.
   */
  private expandFallbackChain(primary: EngineKind): EngineKind[] {
    const configured = this.config.defaultFallbackChain;
    const chain =
      configured === undefined ? DEFAULT_FALLBACK_CHAIN : configured;

    if (!chain.length) {
      return [primary];
    }

    const seen = new Set<EngineKind>();
    const ordered: EngineKind[] = [];

    if (!seen.has(primary)) {
      seen.add(primary);
      ordered.push(primary);
    }

    for (const engine of chain) {
      if (!seen.has(engine)) {
        seen.add(engine);
        ordered.push(engine);
      }
    }

    return ordered;
  }
}
