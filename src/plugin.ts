/**
 * sentinel-bridge — OpenClaw Plugin Manifest & Configuration
 */

export const PLUGIN_META = {
  name: 'sentinel-bridge',
  version: '0.1.0',
  description:
    'Multi-engine routing and session bridge for Claude Code, Codex, Grok & Ollama. ' +
    'Unify provider adapters, routing, and session continuity for OpenClaw.',
  author: 'Adrian Muff',
  license: 'MIT',
  homepage: 'https://github.com/McMuff86/sentinel-bridge',
} as const;

/* ── Config types ─────────────────────────────────────────────── */

export interface EngineConfig {
  /** Absolute path or PATH-resolvable command (e.g. "claude", "/usr/bin/codex") */
  command?: string;
  /** Extra CLI args appended to every invocation */
  args?: string[];
  /** Default model for this engine */
  defaultModel?: string;
  /** Working directory (defaults to gateway cwd) */
  cwd?: string;
  /** Environment variables merged into the subprocess env */
  env?: Record<string, string | undefined>;
  /** Whether this engine is enabled (default: true) */
  enabled?: boolean;
  /** Optional API key override for HTTP-backed engines */
  apiKey?: string;
  /** Optional base URL override for HTTP-backed engines */
  baseUrl?: string;
}

export interface SentinelBridgeConfig {
  engines?: {
    claude?: EngineConfig;
    codex?: EngineConfig;
    grok?: EngineConfig;
    ollama?: EngineConfig;
  };
  /** Engine used when the caller does not specify one */
  defaultEngine?: 'claude' | 'codex' | 'grok' | 'ollama';
  /** Default model ref, e.g. "claude/opus-4.6" */
  defaultModel?: string;
  /**
   * Engines to try in order after the primary when `start` fails (e.g. CLI missing).
   * Set to `[]` to disable. Default: claude → codex → grok.
   */
  defaultFallbackChain?: Array<'claude' | 'codex' | 'grok' | 'ollama'>;
  /** Max concurrent sessions across all engines */
  maxConcurrentSessions?: number;
  /** Session TTL in milliseconds (default: 7 days) */
  sessionTTLMs?: number;
  /** Cleanup sweep cadence in milliseconds */
  cleanupIntervalMs?: number;
  /** Circuit breaker settings for automatic engine disabling after repeated failures */
  circuitBreaker?: {
    failureThreshold?: number;
    cooldownMs?: number;
    halfOpenSuccessThreshold?: number;
  };
}

/* ── Defaults ─────────────────────────────────────────────────── */

export const DEFAULT_CONFIG: SentinelBridgeConfig = {
  engines: {
    claude: {
      command: 'claude',
      defaultModel: 'claude-opus-4-6',
      enabled: true,
    },
    codex: {
      command: 'codex',
      defaultModel: 'gpt-5.4',
      enabled: true,
    },
    grok: {
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: 'grok-4-1-fast',
      enabled: false, // opt-in, needs API key
    },
    ollama: {
      baseUrl: 'http://localhost:11434/v1',
      defaultModel: 'llama3.2',
      enabled: false, // opt-in, needs running Ollama instance
    },
  },
  defaultEngine: 'claude',
  defaultModel: 'claude/claude-opus-4-6',
  defaultFallbackChain: ['claude', 'codex', 'grok', 'ollama'],
  maxConcurrentSessions: 5,
  sessionTTLMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};
