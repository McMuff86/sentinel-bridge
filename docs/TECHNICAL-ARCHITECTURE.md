# Technical Architecture — sentinel-bridge

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           OpenClaw Host                              │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                       sentinel-bridge                          │  │
│  │                       (OpenClaw Plugin)                         │  │
│  │                                                                 │  │
│  │  ┌──────────────┐    ┌───────────────────────────────────────┐  │  │
│  │  │ Tool Layer   │───▶│         SessionManager                │  │  │
│  │  │ (28 sb_*)    │    │                                       │  │  │
│  │  └──────────────┘    │  Sessions    Workflows    Context     │  │  │
│  │                      │  ┌──┐┌──┐   ┌─────┐    ┌─────────┐  │  │  │
│  │                      │  │#1││#2│   │ DAG │    │Blackboard│  │  │  │
│  │                      │  └──┘└──┘   └─────┘    └─────────┘  │  │  │
│  │                      │  Roles      Relay      TaskRouter    │  │  │
│  │                      │  ┌──────┐   ┌─────┐   ┌─────────┐  │  │  │
│  │                      │  │4+cust│   │P2P  │   │heuristic│  │  │  │
│  │                      │  └──────┘   └─────┘   └─────────┘  │  │  │
│  │                      └──────────────────────────────────────┘  │  │
│  │                                                                 │  │
│  │              ┌─────── IEngine Interface ──────────┐             │  │
│  │              │                                    │             │  │
│  │     Claude Engine  Codex Engine  Grok Engine  Ollama Engine     │  │
│  │     (subprocess)   (per-message) (HTTP+retry) (HTTP+SSE)       │  │
│  │                                                                 │  │
│  │  ┌──────────────────────────────────────────────────────────┐  │  │
│  │  │  SessionStore  EventStore  StructuredLog  UsageTracker   │  │  │
│  │  │  (atomic JSON) (JSONL)     (JSON→logger)  (JSONL)        │  │  │
│  │  └──────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                      │
└──────────┬───────────┬───────────┬──────────┬───────────────────────┘
           │           │           │          │
    claude CLI    codex CLI   xAI HTTP   Ollama HTTP
   (subscription) (subscription) (API key)   (local)
```

## IEngine Interface

All engines implement a common interface (defined in `src/types.ts`). This ensures SessionManager can orchestrate them uniformly without engine-specific branching.

```typescript
interface IEngine {
  start(config?: Partial<EngineConfig>): Promise<void>;
  send(message: string): Promise<string>;
  compact(summary?: string): Promise<string>;
  stop(): Promise<void>;
  cancel(): void;                     // Abort in-flight operation without stopping
  status(): EngineStatusSnapshot;
  getSessionId(): string | null;
}
```

Engines throw `EngineError` (from `src/errors.ts`) with typed categories:

| Category | Retriable | Examples |
|----------|-----------|----------|
| `unavailable` | no | CLI not found (ENOENT) |
| `auth_expired` | no | Invalid API key, expired CLI auth |
| `rate_limited` | yes | HTTP 429 |
| `timeout` | yes | Request exceeded deadline |
| `context_overflow` | no | Token limit exceeded (HTTP 413) |
| `transient` | yes | HTTP 5xx, temporary service error |
| `cancelled` | no | User/system cancelled via `cancel()` |
| `unknown` | no | Unclassified |

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
- Non-streaming mode (`stream: false`) for reliable response parsing
- Models: `grok-4-1-fast`, `grok-3`, `grok-4`
- **Retry with exponential backoff** for retriable errors (429, 5xx)
- `cancel()` aborts in-flight request via AbortController
- Compact via conversation history truncation with summary

**Lifecycle:**
```
start()  → validate API key + model → state = running
send()   → POST /chat/completions (with retry) → parse response → string
cancel() → abort AbortController → stay running
stop()   → abort + state = stopped
```

## Orchestration Layer

The `src/orchestration/` directory contains the multi-agent orchestration features that sit on top of the SessionManager:

### WorkflowEngine (`workflow-engine.ts`)
- Validates workflow definitions (DAG cycle detection via DFS, dependency resolution)
- Executes steps in topological order with parallel execution for independent steps
- Propagates upstream outputs to downstream steps via the blackboard
- Handles failure cascading (failed step → dependent steps marked `skipped`)

### RoleRegistry (`roles.ts`) + RoleStore (`role-store.ts`)
- 4 built-in roles: Architect (design focus), Implementer (code generation), Reviewer (code review), Tester (testing)
- Each role has `systemPrompt`, optional `preferredEngine`/`preferredModel`, and `tags`
- Custom roles registered at runtime and persisted via atomic JSON
- On `startSession()` with a role: preferred engine/model applied as defaults, system prompt injected as first message

### ContextStore (`context-store.ts`) + ContextEventStore (`context-events.ts`)
- Workspace-scoped key-value store (atomic JSON per workspace)
- Any session can read/write; workspace-level mutex prevents concurrent writes
- JSONL audit trail for all mutations (`context_set`, `context_deleted`, `context_cleared`)
- Workflow steps automatically store outputs in the blackboard for downstream consumption

### Relay (`relay.ts`)
- `relayMessage(from, to, message)` sends a message to a target session via existing `sendMessage` (inherits all guarantees)
- `broadcastMessage(from, message, exclude?)` sends to all active sessions via `Promise.allSettled`
- Relay events tracked on both source and target session timelines

### TaskRouter (`task-router.ts`) + TaskClassifier (`task-classifier.ts`)
- Heuristic keyword/pattern classifier: `code_generation`, `code_review`, `reasoning`, `fast_task`, `creative`, `local_private`, `general`
- Engine scoring based on capability strengths (code, reasoning, speed, privacy)
- Cost-aware tiebreaking via `cost-tiers.ts`
- Supports `prefer` parameter: `fast`, `cheap`, `capable`
- Advisory only — does not start sessions

## SessionManager

The SessionManager is the central orchestrator. It owns all active sessions and provides the API surface that tools call. Delegates to focused modules:

- `src/routing/*` — model resolution, fallback ordering, routing trace, capability hints
- `src/engines/create-engine.ts` — engine construction
- `src/sessions/session-store.ts` — JSON persistence (atomic writes)
- `src/sessions/session-events.ts` — JSONL event timeline
- `src/sessions/session-mutex.ts` — per-session promise-based lock
- `src/sessions/session-cleanup.ts` — TTL expiry sweep
- `src/sessions/session-info.ts` — session payload shaping
- `src/errors.ts` — EngineError with typed categories
- `src/logging.ts` — StructuredLogger

```typescript
class SessionManager {
  // ── Session Lifecycle (mutex-protected) ────────────
  startSession(opts: SessionStartOptions): Promise<SessionInfo>;  // now accepts role
  sendMessage(name: string, message: string): Promise<SendMessageResult>;
  stopSession(name: string): Promise<void>;
  cancelSession(name: string): SessionInfo;
  compactSession(name: string, summary?: string): Promise<SendMessageResult>;

  // ── Queries ────────────────────────────────────────
  listSessions(): SessionInfo[];
  getSessionStatus(name: string): SessionInfo | undefined;
  getOverview(): SessionOverview;
  getCostReport(since?: string): CostReport;
  resolveModelRoute(model: string, preferredEngine?: EngineKind): ModelRoute;

  // ── Workflow Orchestration ─────────────────────────
  startWorkflow(definition: WorkflowDefinition): Promise<WorkflowState>;
  getWorkflowStatus(id: string): WorkflowState | undefined;
  cancelWorkflow(id: string): WorkflowState;
  listWorkflows(): WorkflowState[];

  // ── Relay ──────────────────────────────────────────
  relayMessage(from, to, message, onChunk?): Promise<RelayResult>;
  broadcastMessage(from, message, exclude?): Promise<BroadcastResult>;

  // ── Roles ──────────────────────────────────────────
  registerRole(role: AgentRole): void;
  readonly roles: RoleRegistry;

  // ── Context (Blackboard) ───────────────────────────
  setContext(workspace, key, value, setBy): Promise<ContextEntry>;
  getContext(workspace, key): ContextEntry | undefined;
  listContext(workspace): ContextEntry[];
  clearContext(workspace, clearedBy): Promise<void>;

  // ── Cleanup ────────────────────────────────────────
  shutdown(): Promise<void>;
}
```

### Session Name Validation

Session names must match `^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,63}$` (1-64 chars, alphanumeric start). This prevents path traversal and file system issues.

### TTL & Cleanup

- Configurable via plugin `sessionTTLMs` and `cleanupIntervalMs` (**milliseconds**); see `src/plugin.ts` / `SessionManager` defaults
- Periodic sweep removes idle sessions past TTL
- Cleanup logic now lives in `src/sessions/session-cleanup.ts`
- Session resume uses engine-level `resumeSessionId` where supported (see Claude engine)

### Concurrency

- `maxConcurrentSessions` limit (default: 5)
- New session requests beyond the limit return an error
- **Per-session mutex** serialises send/stop/compact on the same session — no race conditions
- **Rehydration deduplication** prevents concurrent rehydration of the same session
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

## Capability-based routing (light)

A minimal capability layer now exists for primary-engine selection when the caller does **not** explicitly choose an engine or model:

- if `resumeSessionId` is present, prefer an engine that supports resume
- if `cwd` is present, prefer an engine that supports working-directory state
- otherwise fall back to the configured default engine

This logic intentionally stays small and conservative. It is a seed for future policy expansion, not a full scoring system.

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

Each engine tracks token usage via `EngineUsageSnapshot` and computes cost per turn:

```typescript
interface EngineUsageSnapshot {
  costUsd: number;
  tokenCount: { input: number; output: number; cachedInput: number; total: number };
  lastError?: string;
  lastResponseAt?: Date;
}
```

`sb_cost_report` aggregates across sessions with per-engine breakdowns and subscription savings.

### Pricing Table

Maintained as embedded defaults per engine. Users can override via `pricing` in engine config.

| Model | Input/1M | Output/1M | Cached/1M |
|-------|----------|-----------|-----------|
| claude-opus-4-6 | $15.00 | $75.00 | $1.50 |
| claude-sonnet-4-5 | $3.00 | $15.00 | $0.30 |
| gpt-5.4 | $2.50 | $15.00 | $0.25 |
| o4-mini | $1.25 | $10.00 | $0.125 |
| grok-4-1-fast | $0.20 | $0.50 | $0.05 |
| grok-3 / grok-4 | $3.00 | $15.00 | $0.75 |

**Note:** Costs in sentinel-bridge are tracking metadata for observability. Real billing depends on the backing engine/account configuration on the host.

### Aggregation

`sb_cost_report` tool returns:
- Per-session breakdown
- Per-engine totals
- Grand total (with subscription savings highlighted)

## Error Handling & Fallback Strategy

### Error Categories (implemented in `src/errors.ts`)

All engines throw `EngineError` with a typed `category` and `retriable` flag:

| Category | Retriable | Examples | Handling |
|----------|-----------|----------|----------|
| `unavailable` | no | CLI not found (ENOENT) | Immediate fallback to next engine |
| `auth_expired` | no | Invalid API key, expired CLI auth | Immediate error with guidance |
| `rate_limited` | yes | HTTP 429 from Grok | Retry with exponential backoff (1s/2s/4s), respects `Retry-After` |
| `timeout` | yes | Request exceeded deadline | Retry or fallback |
| `context_overflow` | no | Token limit exceeded (HTTP 413) | Error to caller |
| `transient` | yes | HTTP 5xx, temporary service error | Retry with backoff |
| `cancelled` | no | User cancelled via `sb_session_cancel` | No retry |
| `unknown` | no | Unclassified | Fallback to next engine |

### Grok Retry

Grok engine retries retriable errors up to 3 times with exponential backoff:
- Base: 1s → 2s → 4s (capped at 10s)
- Respects `Retry-After` header when present
- Non-retriable errors (auth, context overflow) fail immediately

### Fallback Chain (start only)

```
Primary engine start() fails
  → Error categorized (EngineError.category logged)
  → Try next engine in defaultFallbackChain
  → Each engine uses its own default model (not the user's alias)
  → If all fail: last error rethrown
```

Fallback applies **only to `startSession`**. `sendMessage` does not fall back — the session is bound to one engine. Configure `defaultFallbackChain: []` to disable.

### Periodic Cleanup

SessionManager runs a periodic sweep (default: every hour):
- Remove in-memory sessions past TTL
- Purge persisted sessions that expired while plugin was offline
- Clear event logs for expired sessions
