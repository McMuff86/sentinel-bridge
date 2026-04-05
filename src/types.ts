export type EngineState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'error';

export type SessionStatus = 'active' | 'stopped' | 'expired' | 'error';

export type EngineKind = 'claude' | 'codex' | 'grok';

export type ModelRouteSource = 'explicit' | 'alias' | 'default';

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cachedInput: number;
  total: number;
}

export interface EngineUsageSnapshot {
  costUsd: number;
  tokenCount: TokenUsage;
  lastError?: string;
  lastResponseAt?: Date;
}

export interface EngineStatusSnapshot {
  state: EngineState;
  sessionId: string | null;
  model: string;
  usage: EngineUsageSnapshot;
}

export interface EngineConfig {
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
}

export interface SentinelBridgeConfig {
  ttlMs?: number;
  cleanupIntervalMs?: number;
  maxConcurrentSessions?: number;
  defaultCwd?: string;
  defaultEngine?: EngineKind;
  defaultModel?: string;
  /**
   * When starting a session fails, try the next engine in this order after the primary.
   * Primary is always attempted first. Use [] to disable fallback retries.
   */
  defaultFallbackChain?: EngineKind[];
  claude?: Partial<EngineConfig>;
  codex?: Partial<EngineConfig>;
  grok?: Partial<EngineConfig>;
}

export interface IEngine {
  start(config?: Partial<EngineConfig>): Promise<void>;
  send(message: string): Promise<string>;
  compact(summary?: string): Promise<string>;
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

export interface SessionStartOptions {
  name: string;
  engine?: EngineKind;
  model?: string;
  cwd?: string;
  resumeSessionId?: string;
}

export interface RoutingTraceAttempt {
  engine: EngineKind;
  model: string;
  ok: boolean;
  error?: string;
}

export interface RoutingTrace {
  requestedModel: string | null;
  requestedEngine?: EngineKind;
  primary: ModelRoute;
  fallbackChain: EngineKind[];
  attempts: RoutingTraceAttempt[];
  selectedEngine?: EngineKind;
  selectedModel?: string;
}

export interface SessionInfo extends ISession {
  name: string;
  cwd: string | null;
  engineState: EngineState;
  engineSessionId: string | null;
  lastTouchedAt: Date;
  lastError?: string;
  routingTrace?: RoutingTrace;
}

export interface SendMessageResult {
  name: string;
  output: string;
  session: SessionInfo;
}

export interface EngineCostBreakdown {
  sessionCount: number;
  costUsd: number;
  tokenCount: TokenUsage;
}

export interface SessionOverview {
  totalSessions: number;
  activeSessions: number;
  stoppedSessions: number;
  expiredSessions: number;
  errorSessions: number;
  totalCostUsd: number;
  byEngine: Record<EngineKind, EngineCostBreakdown>;
}

export interface CostReport {
  since: string | null;
  totalUsd: number;
  trackedUsd: number;
  byEngine: Record<EngineKind, EngineCostBreakdown>;
  subscriptionSaved: number;
}

export interface ModelRoute {
  model: string;
  engine: EngineKind;
  subscriptionCovered: boolean;
  source: ModelRouteSource;
}
