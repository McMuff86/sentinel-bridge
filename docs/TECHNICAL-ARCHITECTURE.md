# Technical Architecture — sentinel-bridge

## System Overview

```
┌──────────────────────────────────────────────────────────────┐
│                        OpenClaw Host                         │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                   sentinel-bridge                      │  │
│  │                   (OpenClaw Plugin)                     │  │
│  │                                                        │  │
│  │  ┌──────────────┐    ┌─────────────────────────────┐   │  │
│  │  │ Tool Layer   │───▶│     SessionManager          │   │  │
│  │  │ (sb_*)       │    │                             │   │  │
│  │  └──────────────┘    │  ┌───────┐ ┌───────┐       │   │  │
│  │                      │  │Session│ │Session│ ...    │   │  │
│  │                      │  │  #1   │ │  #2   │       │   │  │
│  │                      │  └───┬───┘ └───┬───┘       │   │  │
│  │                      └─────┼─────────┼────────────┘   │  │
│  │                            │         │                 │  │
│  │              ┌─────────────┼─────────┼──────────┐     │  │
│  │              │       IEngine Interface           │     │  │
│  │              └─────────────┼─────────┼──────────┘     │  │
│  │                            │         │                 │  │
│  │         ┌──────────┐ ┌────┴───┐ ┌───┴──────┐         │  │
│  │         │  Claude   │ │ Codex  │ │   Grok   │         │  │
│  │         │  Engine   │ │ Engine │ │  Engine  │         │  │
│  │         └─────┬─────┘ └───┬────┘ └────┬─────┘         │  │
│  │               │           │           │                │  │
│  └───────────────┼───────────┼───────────┼────────────────┘  │
│                  │           │           │                    │
└──────────────────┼───────────┼───────────┼────────────────────┘
                   │           │           │
           ┌───────▼──┐  ┌────▼────┐  ┌───▼─────┐
           │claude CLI│  │codex CLI│  │xAI HTTP │
           │(sub auth)│  │(API key)│  │(API key)│
           └──────────┘  └─────────┘  └─────────┘
```

## IEngine Interface

All engines implement a common interface. This ensures SessionManager can orchestrate them uniformly without engine-specific branching.

```typescript
interface IEngine extends EventEmitter {
  // ── Identity ──────────────────────────────────────────────
  readonly engineType: EngineType;      // 'claude' | 'codex' | 'grok'
  sessionId?: string;

  // ── State ─────────────────────────────────────────────────
  readonly isReady: boolean;
  readonly isPaused: boolean;
  readonly isBusy: boolean;

  // ── Lifecycle ─────────────────────────────────────────────
  start(config: EngineStartConfig): Promise<this>;
  stop(): void;
  pause(): void;
  resume(): void;

  // ── Communication ─────────────────────────────────────────
  send(message: string, options?: SendOptions): Promise<TurnResult>;

  // ── Observability ─────────────────────────────────────────
  getStats(): EngineStats;
  getCost(): CostBreakdown;
  getHistory(limit?: number): HistoryEntry[];

  // ── Context Management ────────────────────────────────────
  compact(summary?: string): Promise<TurnResult>;
  getEffort(): EffortLevel;
  setEffort(level: EffortLevel): void;

  // ── Model ─────────────────────────────────────────────────
  resolveModel(alias: string): string;
}
```

### Events emitted by all engines

| Event | Payload | Description |
|-------|---------|-------------|
| `ready` | — | Engine subprocess is initialized and accepting messages |
| `text` | `string` | Streaming text chunk from engine |
| `tool_use` | `{ tool, input }` | Engine is invoking a tool |
| `tool_result` | `{ tool, output, error? }` | Tool execution completed |
| `turn_complete` | `TurnResult` | Full turn finished |
| `error` | `Error` | Engine error (process crash, timeout, etc.) |
| `exit` | `{ code, signal }` | Engine process exited |

## Engine Implementations

### ClaudeEngine

**Transport:** Spawns `claude` CLI as a child process with `--output-format stream-json` and `--input-format stream-json`. Communication is line-delimited JSON over stdin/stdout.

**Auth flow:** Claude Code CLI uses the user's existing CLI credentials (typically via `claude login`). No API key is required in sentinel-bridge config.

**Key behaviors:**
- Long-running subprocess (persistent session)
- Supports `--resume` for session continuation after restart
- Streaming JSON protocol: each line is a `StreamEvent`
- Tracks `session_id` from init response for resume capability
- Permission modes: `acceptEdits`, `bypassPermissions`, `plan`, etc.
- Model switching via process restart with `--resume`

**Lifecycle:**
```
start() → spawn claude CLI → wait for init_session event → isReady = true
send()  → write JSON to stdin → collect stream events → return TurnResult
stop()  → SIGTERM → wait for exit → cleanup
```

### CodexEngine

**Transport:** Spawns `codex` CLI per-message (not persistent process). Each `send()` creates a new `codex` process in quiet + full-auto mode. Session persistence is achieved through the shared working directory.

**Auth flow:** Uses Codex CLI authentication and may also honor env-backed auth such as `OPENAI_API_KEY`, depending on host setup.

**Key behaviors:**
- One-shot process per message (no persistent subprocess)
- Working directory carries state between sends (code changes accumulate)
- Supports `--model` flag for model selection (e.g., `o4-mini`, `codex-mini`)
- `--quiet` mode for structured output
- `--full-auto` for no permission prompts
- Cost tracked per-invocation via token counts in output

**Lifecycle:**
```
start() → validate codex binary exists → isReady = true
send()  → spawn codex process → wait for completion → parse output → TurnResult
stop()  → kill active process if any → cleanup
```

### GrokEngine

**Transport:** HTTP client to xAI's Grok API (`https://api.x.ai/v1/chat/completions`). Uses OpenAI-compatible chat completions format.

**Auth flow:** Uses `XAI_API_KEY` environment variable. Standard xAI API billing applies.

**Key behaviors:**
- HTTP-based (no subprocess)
- Maintains conversation history in-memory for multi-turn
- Supports streaming via SSE (`stream: true`)
- Models: `grok-3`, `grok-3-mini`, `grok-2`
- Tool use via OpenAI-compatible function calling format
- Compact via conversation history truncation with summary

**Lifecycle:**
```
start() → validate API key → isReady = true
send()  → POST /chat/completions → parse response → TurnResult
stop()  → clear conversation history → cleanup
```

## SessionManager

The SessionManager is the central orchestrator. It owns all active sessions and provides the API surface that tools call.

After the current refactor pass, it is deliberately thinner than before:

- `src/routing/resolve-model-route.ts` handles model resolution
- `src/routing/expand-fallback-chain.ts` handles fallback ordering
- `src/routing/routing-trace.ts` captures routing decisions during session start
- `src/routing/provider-capabilities.ts` is a light capability registry for future routing rules
- `src/engines/create-engine.ts` handles engine construction
- `src/sessions/session-info.ts` shapes session/status payloads
- `src/sessions/session-cleanup.ts` owns TTL expiry cleanup

```typescript
class SessionManager {
  private sessions: Map<string, ManagedSession>;
  private config: PluginConfig;
  private persistedSessions: Map<string, PersistedSession>;

  // ── Session Lifecycle ──────────────────────────────
  startSession(opts: SessionStartOpts): Promise<SessionInfo>;
  stopSession(name: string): Promise<void>;
  listSessions(): SessionInfo[];

  // ── Communication ──────────────────────────────────
  sendMessage(name: string, message: string, opts?: SendOpts): Promise<SendResult>;

  // ── Observability ──────────────────────────────────
  getStatus(name: string): SessionStatus;
  health(): HealthReport;

  // ── Session Management ─────────────────────────────
  compactSession(name: string, summary?: string): Promise<void>;
  switchModel(name: string, model: string): Promise<SessionInfo>;
  switchEngine(name: string, engine: EngineType): Promise<SessionInfo>;

  // ── Cleanup ────────────────────────────────────────
  shutdown(): Promise<void>;
}
```

### ManagedSession (internal)

```typescript
interface ManagedSession {
  engine: IEngine;
  config: SessionConfig;
  created: string;
  lastActivity: string;
  engineType: EngineType;
}
```

### Session Name Generation

Auto-generated names follow the pattern: `{engine}-{adjective}-{noun}` (e.g., `claude-swift-falcon`, `codex-bold-raven`).

### TTL & Cleanup

- Configurable via plugin `sessionTTLMs` and `cleanupIntervalMs` (**milliseconds**); see `src/plugin.ts` / `SessionManager` defaults
- Periodic sweep removes idle sessions past TTL
- Cleanup logic now lives in `src/sessions/session-cleanup.ts`
- Session resume uses engine-level `resumeSessionId` where supported (see Claude engine)

### Concurrency

- `maxConcurrentSessions` limit (default: 5)
- New session requests beyond the limit return an error with active session names
- Each engine runs in its own subprocess/context — no shared state

## Routing trace

Session starts now capture a minimal routing trace that records:

- requested model / requested engine
- primary resolved route
- fallback chain considered
- each attempted engine/model pair
- selected engine/model on success
- failure reason on unsuccessful attempts

This trace is exposed through session status/info payloads and is meant as the first observability seam for future policy work.

## OpenClaw Plugin Integration

sentinel-bridge registers as an OpenClaw plugin. The **authoritative manifest** is the repo root **`openclaw.plugin.json`** (entry `main`: `./dist/index.js`, export `activate` from `src/index.ts`). Tool names and config schema there should match `buildTools()` and `src/plugin.ts`.

**Live install note:** OpenClaw’s expected manifest fields may differ by version — validate against your OpenClaw release when something fails to load.

### Registration Flow

```
OpenClaw loads plugin
  → plugin.register(api) called
  → Tools registered (sb_* namespace)
  → Service registered (lazy init)
  → First tool call triggers SessionManager creation
```

### Lazy Initialization

`SessionManager` is created in `activate()` when the plugin loads; engine subprocesses start on `sb_session_start` / `start()`. Adjust this section if you change `activate()` to defer manager creation.

## Auth Flow

### Claude (Subscription Passthrough)

```
User has Claude Max subscription
  → `claude login` stores OAuth token in ~/.claude/
  → sentinel-bridge spawns `claude` CLI
  → CLI uses stored OAuth token automatically
  → All usage billed against subscription (no extra cost)
  → No API key needed in sentinel-bridge config
```

### Codex (API Key)

```
User sets OPENAI_API_KEY env var
  → sentinel-bridge passes env to codex subprocess
  → Codex CLI uses API key for OpenAI billing
  → Cost tracked per-session
```

### Grok (API Key)

```
User sets XAI_API_KEY env var (or configures in plugin config)
  → sentinel-bridge sends key in Authorization header
  → Standard xAI API billing applies
  → Cost tracked per-session
```

## Cost Tracking

Each engine tracks token usage and computes cost using a model pricing table:

```typescript
interface CostBreakdown {
  engine: EngineType;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  pricing: ModelPricing;
  totalUsd: number;
  subscriptionCovered: boolean;  // true for Claude with subscription
}
```

### Pricing Table

Maintained as a runtime-mutable map with known defaults. Users can override via `pricingOverrides` in plugin config.

| Model | Input/1M | Output/1M | Cached/1M |
|-------|----------|-----------|-----------|
| claude-opus-4 | $15.00 | $75.00 | $1.50 |
| claude-sonnet-4 | $3.00 | $15.00 | $0.30 |
| o4-mini | $1.10 | $4.40 | — |
| codex-mini | $1.50 | $6.00 | — |
| grok-3 | $3.00 | $15.00 | — |
| grok-3-mini | $0.30 | $0.50 | — |

**Note:** Costs in sentinel-bridge are tracking metadata for observability. Real billing depends on the backing engine/account configuration on the host.

### Aggregation

`sb_cost_report` tool returns:
- Per-session breakdown
- Per-engine totals
- Grand total (with subscription savings highlighted)

## Error Handling & Fallback Strategy

### Error Categories

| Category | Examples | Handling |
|----------|----------|----------|
| `engine_unavailable` | CLI not installed, API key missing | Immediate error, suggest setup |
| `engine_crash` | Process exit non-zero, segfault | Attempt restart with `--resume` (Claude), retry (Codex), error (Grok) |
| `timeout` | No response within deadline | Kill process, return partial output if any |
| `rate_limit` | 429 from API | Exponential backoff (3 retries, 1s/2s/4s) |
| `context_overflow` | Token limit exceeded | Auto-compact, retry send |
| `auth_failure` | Expired token, invalid key | Error with specific guidance |

### Fallback Chain

When `fallbackEngine` is configured:

```
Primary engine fails
  → Error categorized
  → If retriable: retry with backoff (max 3)
  → If not retriable + fallback configured:
      → Start fallback engine session
      → Replay last message
      → Return result with `fallback: true` flag
  → If no fallback: return error to caller
```

### Fallback is opt-in, not automatic. Users must explicitly configure `fallbackEngine` in plugin config.

### Health Checks

SessionManager runs periodic health checks (every 60s):
- Verify engine processes are alive (Claude, Codex)
- Check API reachability (Grok)
- Clean up dead sessions
- Persist session metadata for resume
