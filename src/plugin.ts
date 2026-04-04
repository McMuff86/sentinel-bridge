/**
 * sentinel-bridge — OpenClaw Plugin Manifest & Configuration
 */

export const PLUGIN_META = {
  name: 'sentinel-bridge',
  version: '0.1.0',
  description:
    'Multi-engine provider bridge for Claude Code, Codex & Grok. ' +
    'Route OpenClaw through your existing subscriptions.',
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
  env?: Record<string, string>;
  /** Whether this engine is enabled (default: true) */
  enabled?: boolean;
}

export interface SentinelBridgeConfig {
  engines?: {
    claude?: EngineConfig;
    codex?: EngineConfig;
    grok?: EngineConfig & { apiKey?: string; baseUrl?: string };
  };
  /** Default model ref, e.g. "claude/opus-4.6" */
  defaultModel?: string;
  /** Max concurrent sessions across all engines */
  maxConcurrentSessions?: number;
  /** Session TTL in milliseconds (default: 7 days) */
  sessionTTLMs?: number;
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
  },
  defaultModel: 'claude/claude-opus-4-6',
  maxConcurrentSessions: 5,
  sessionTTLMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};
