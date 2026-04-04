export type EngineState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

export type SessionStatus = "active" | "stopped" | "expired" | "error";

export type EngineKind = "claude" | "codex" | "grok";

export type ModelPricing = {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M: number;
};

export type TokenUsage = {
  input: number;
  output: number;
  cachedInput: number;
  total: number;
};

export type EngineUsageSnapshot = {
  costUsd: number;
  tokenCount: TokenUsage;
  lastError?: string;
  lastResponseAt?: Date;
};

export type EngineStatusSnapshot = {
  state: EngineState;
  sessionId: string | null;
  model: string;
  usage: EngineUsageSnapshot;
};

export type EngineConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  model: string;
  cwd?: string;
  resumeSessionId?: string;
  timeoutMs?: number;
  apiKey?: string;
  baseUrl?: string;
  pricing?: Partial<ModelPricing>;
};

export type SentinelBridgeConfig = {
  ttlMs?: number;
  cleanupIntervalMs?: number;
  maxConcurrentSessions?: number;
  defaultCwd?: string;
  claude?: Partial<EngineConfig>;
  codex?: Partial<EngineConfig>;
  grok?: Partial<EngineConfig>;
};

export interface IEngine {
  start(config?: Partial<EngineConfig>): Promise<void>;
  send(message: string): Promise<string>;
  stop(): Promise<void>;
  status(): EngineStatusSnapshot;
  getSessionId(): string | null;
}

export interface ISession {
  id: string;
  engine: EngineKind;
  model: string;
  status: SessionStatus;
  createdAt: Date;
  costUsd: number;
  tokenCount: TokenUsage;
}
