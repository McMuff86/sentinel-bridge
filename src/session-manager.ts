import { ClaudeEngine } from "./engines/claude-engine.js";
import { CodexEngine } from "./engines/codex-engine.js";
import { GrokEngine } from "./engines/grok-engine.js";
import { emptyTokenUsage, mergeEngineConfig } from "./engines/shared.js";
import type {
  EngineConfig,
  EngineKind,
  IEngine,
  ISession,
  SentinelBridgeConfig,
} from "./types.js";

type SessionRecord = {
  engineInstance: IEngine;
  session: ISession;
  lastTouchedAt: number;
};

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_SESSIONS = 8;

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly config: SentinelBridgeConfig;
  private cleanupTimer: any = null;

  constructor(config: SentinelBridgeConfig = {}) {
    this.config = config;

    const cleanupIntervalMs =
      config.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;

    if (cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupExpiredSessions();
      }, cleanupIntervalMs);

      this.cleanupTimer?.unref?.();
    }
  }

  async start(
    name: string,
    engine: EngineKind,
    config: Partial<EngineConfig> = {},
  ): Promise<ISession> {
    this.cleanupExpiredSessions();

    if (!name.trim()) {
      throw new Error("Session name is required.");
    }

    const existing = this.sessions.get(name);
    if (existing?.session.status === "active") {
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

    await engineInstance.start();

    const now = Date.now();
    const session: ISession = {
      id: crypto.randomUUID(),
      engine,
      model: resolvedConfig.model,
      status: "active",
      createdAt: new Date(now),
      costUsd: 0,
      tokenCount: emptyTokenUsage(),
    };

    const record: SessionRecord = {
      engineInstance,
      session,
      lastTouchedAt: now,
    };

    this.syncSession(record);
    this.sessions.set(name, record);

    return this.cloneSession(record.session);
  }

  async send(name: string, message: string): Promise<string> {
    this.cleanupExpiredSessions();

    const record = this.requireSession(name);
    if (record.session.status !== "active") {
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
      throw error;
    }
  }

  async stop(name: string): Promise<void> {
    this.cleanupExpiredSessions();

    const record = this.requireSession(name);

    await record.engineInstance.stop();
    record.lastTouchedAt = Date.now();
    this.syncSession(record);
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
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const records = Array.from(this.sessions.values());
    this.sessions.clear();

    await Promise.allSettled(records.map((record) => record.engineInstance.stop()));
  }

  private cleanupExpiredSessions(): void {
    const ttlMs = this.config.ttlMs ?? DEFAULT_TTL_MS;
    const now = Date.now();

    for (const [name, record] of this.sessions.entries()) {
      if (now - record.lastTouchedAt < ttlMs) {
        continue;
      }

      record.session.status = "expired";
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
      (record) => record.session.status === "active",
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
        model: defaults.model ?? config.model ?? "",
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
      case "claude":
        return this.config.claude ?? {};
      case "codex":
        return this.config.codex ?? {};
      case "grok":
        return this.config.grok ?? {};
      default: {
        const exhaustiveCheck: never = engine;
        throw new Error(`Unsupported engine: ${exhaustiveCheck}`);
      }
    }
  }

  private createEngine(engine: EngineKind, config: EngineConfig): IEngine {
    switch (engine) {
      case "claude":
        return new ClaudeEngine(config);
      case "codex":
        return new CodexEngine(config);
      case "grok":
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

  private syncSession(record: SessionRecord): void {
    const engineStatus = record.engineInstance.status();

    record.session.model = engineStatus.model;
    record.session.costUsd = engineStatus.usage.costUsd;
    record.session.tokenCount = { ...engineStatus.usage.tokenCount };

    if (record.session.status === "expired") {
      return;
    }

    if (engineStatus.state === "error") {
      record.session.status = "error";
      return;
    }

    if (engineStatus.state === "stopped") {
      record.session.status = "stopped";
      return;
    }

    record.session.status = "active";
  }

  private cloneSession(session: ISession): ISession {
    return {
      ...session,
      createdAt: new Date(session.createdAt),
      tokenCount: { ...session.tokenCount },
    };
  }
}
