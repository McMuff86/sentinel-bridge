export type EngineState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'error';

export type SessionStatus = 'active' | 'stopped' | 'expired' | 'error';

export type SessionPhase =
  | 'starting'
  | 'idle'
  | 'sending'
  | 'compacting'
  | 'stopping'
  | 'stopped';

export type SessionAction = 'start' | 'send' | 'compact' | 'stop' | 'rehydrate';

export type EngineKind = 'claude' | 'codex' | 'grok' | 'ollama';

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

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit. Default: 5 */
  failureThreshold?: number;
  /** Milliseconds to wait before transitioning from open to half-open. Default: 60000 */
  cooldownMs?: number;
  /** Number of successes in half-open state to close the circuit. Default: 1 */
  halfOpenSuccessThreshold?: number;
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
  /** Circuit breaker settings for automatic engine disabling after repeated failures. */
  circuitBreaker?: CircuitBreakerConfig;
  /** Session queue settings for backpressure when at max capacity. */
  queue?: {
    maxDepth?: number;
    timeoutMs?: number;
  };
  /** Health check settings for periodic engine probing. */
  healthCheck?: {
    intervalMs?: number;
    probeTimeoutMs?: number;
    grokBaseUrl?: string;
    grokApiKey?: string;
    ollamaBaseUrl?: string;
  };
  claude?: Partial<EngineConfig>;
  codex?: Partial<EngineConfig>;
  grok?: Partial<EngineConfig>;
  ollama?: Partial<EngineConfig>;
}

export interface IEngine {
  start(config?: Partial<EngineConfig>): Promise<void>;
  send(message: string, onChunk?: (chunk: string) => void): Promise<string>;
  compact(summary?: string): Promise<string>;
  stop(): Promise<void>;
  /** Cancel the current in-flight operation without stopping the session. */
  cancel(): void;
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
  role?: string;
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

export interface SessionActivity {
  phase: SessionPhase;
  lastAction: SessionAction;
  updatedAt: Date;
  lastPromptPreview: string | null;
  lastResponsePreview: string | null;
  isRehydrated: boolean;
}

export interface SessionInfo extends ISession {
  name: string;
  cwd: string | null;
  engineState: EngineState;
  engineSessionId: string | null;
  lastTouchedAt: Date;
  lastError?: string;
  routingTrace?: RoutingTrace;
  activity: SessionActivity;
  turnCount: number;
  role?: string;
}

export interface TurnUsage {
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface SendMessageResult {
  name: string;
  output: string;
  session: SessionInfo;
  turnUsage: TurnUsage;
}

export interface EngineCostBreakdown {
  sessionCount: number;
  costUsd: number;
  tokenCount: TokenUsage;
}

export interface SessionSummary {
  name: string;
  engine: EngineKind;
  model: string;
  status: SessionStatus;
  phase: SessionPhase;
  costUsd: number;
  turnCount: number;
  lastAction: SessionAction;
  updatedAt: Date;
}

export interface SessionOverview {
  totalSessions: number;
  activeSessions: number;
  stoppedSessions: number;
  expiredSessions: number;
  errorSessions: number;
  totalCostUsd: number;
  byEngine: Record<EngineKind, EngineCostBreakdown>;
  sessions: SessionSummary[];
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
