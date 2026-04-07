# Context handoff — sentinel-bridge

This file is for **future agents and contributors** so they can continue work without re-reading the entire tree. See also [AGENTS.md](../AGENTS.md) (style and rules), [TECHNICAL-ARCHITECTURE.md](./TECHNICAL-ARCHITECTURE.md), [API-REFERENCE.md](./API-REFERENCE.md), and **[LIVE-VERIFICATION.md](./LIVE-VERIFICATION.md)** (pre-flight checklist before real OpenClaw + CLI tests).

## What this project is

OpenClaw plugin that exposes **Claude Code CLI**, **Codex CLI**, **Grok (HTTP API)**, and **Ollama (local LLM)** behind one `SessionManager` with a full multi-agent orchestration layer. 28 tools in the `sb_*` namespace in `src/index.ts`.

The project is structured into focused modules:
- `orchestration/` — multi-agent coordination: workflows (DAG), roles (4 built-in + custom), shared context (blackboard), relay (session-to-session), task-based routing (heuristic classifier)
- `routing/` — model aliases, resolution, fallback expansion, routing trace, capability hints
- `engines/` — engine adapters (Claude CLI, Codex CLI, Grok HTTP, Ollama HTTP/SSE) + factory + shared utilities
- `sessions/` — session store (atomic JSON), event store (JSONL), mutex, cleanup, info shaping
- `session-manager.ts` — central orchestrator (sessions, context, roles, workflows, relay)
- `errors.ts` — `EngineError` with typed categories and retry metadata
- `logging.ts` — `StructuredLogger` with JSON entries and external logger integration

## Current state (as of 2026-04-07)

Architecture is stable with a full multi-agent orchestration layer on top of the session manager.

**Session layer (stable):**
- Session-level mutex for concurrency safety
- Atomic store writes to prevent data loss
- Error categorization with `EngineError` class (8 categories, `retriable` flag)
- Grok/Ollama retry with exponential backoff for retriable errors
- Session cancel (`sb_session_cancel`) for aborting in-flight operations
- Structured logging at all key lifecycle points
- CI via GitHub Actions (test on push/PR to main)

**Orchestration layer (new):**
- Shared context/blackboard — workspace-scoped KV store, atomic JSON, JSONL audit
- Agent roles — 4 built-in (Architect, Implementer, Reviewer, Tester) + custom, system prompt injection
- Message relay + broadcast — session-to-session messaging, `Promise.allSettled` for fault tolerance
- Workflow DAG engine — dependency resolution, parallel execution, pipeline/fan-out templates
- Content-based task routing — heuristic classifier, cost-aware, `fast`/`cheap`/`capable` modes

## Key code paths

| Area | File | Notes |
|------|------|--------|
| Plugin entry | `src/index.ts` | `activate()`, 28 tool handlers, config merge, logger wiring |
| Orchestration | `src/session-manager.ts` | Central orchestrator: sessions + context + roles + workflows + relay |
| Workflows | `src/orchestration/workflow-engine.ts` | DAG validation, topological execution, failure cascading |
| Roles | `src/orchestration/roles.ts` | 4 built-in roles, RoleRegistry, system prompt injection |
| Context | `src/orchestration/context-store.ts` | Shared blackboard per workspace, atomic JSON |
| Relay | `src/orchestration/relay.ts` | Session-to-session messaging types |
| Task Router | `src/orchestration/task-router.ts` | Content-based engine recommendation |
| Errors | `src/errors.ts` | `EngineError` with typed `ErrorCategory` and `retriable` flag |
| Logging | `src/logging.ts` | `StructuredLogger` with JSON entries and categories |
| Routing | `src/routing/*` | aliases, resolution, fallback order, routing trace, capability hints |
| Sessions | `src/sessions/*` | store (atomic JSON), events (JSONL), mutex, cleanup, info shaping |
| Plugin defaults | `src/plugin.ts` | `DEFAULT_CONFIG`, OpenClaw-facing config shape |
| Shared types | `src/types.ts` | `IEngine`, `EngineKind`, `SentinelBridgeConfig`, `ModelRoute`, etc. |
| Engines | `src/engines/*.ts` | **Isolated** per engine; throw `EngineError`; Grok has retry logic |
| Tracking | `src/tracking.ts` | JSONL usage logging, per-session/engine/day summaries |

## Model routing (current behavior)

- **Prefix form:** `claude/...`, `codex/...` or `openai/...`, `grok/...` or `xai/...` forces engine.
- **Inference:** e.g. `claude-*`, `opus` / `sonnet` / `haiku` → Claude; `gpt-*`, `codex` → Codex; `grok-*` → Grok.
- **Aliases:** per-engine map in `src/routing/model-aliases.ts` (e.g. `opus` → `claude-opus-4-6`, `codex` → `gpt-5.4`).
- **Trace:** session start stores attempted routes in `routingTrace` for observability.

## Fallback chain (current behavior)

- Config: `defaultFallbackChain` on **plugin** config (`SentinelBridgeConfig` in `plugin.ts`), mirrored in **internal** `types.SentinelBridgeConfig` as `defaultFallbackChain`.
- Default order: **`["claude", "codex", "grok"]`**.
- **`startSession` only:** if `start()` throws, the manager tries the next engine in the expanded order (primary first, then chain entries without duplicates). **`sendMessage` does not fall back** (session is already bound to one engine).
- **`defaultFallbackChain: []`** disables retries (primary only).
- **`resumeSessionId`** is passed only on the **first** attempt; later attempts omit it (wrong engine would ignore or mishandle it).
- On failed `start()`, `SessionManager` calls `engine.stop()` best-effort before propagating so the next engine attempt is clean.

## Testing

```bash
npm test
npm run lint
```

Engine unit tests under `src/__tests__/` are not all present in minimal checkouts; **session-manager** tests mock `ClaudeEngine` / `CodexEngine` / `GrokEngine` to avoid real CLI/API.

## Suggested next tasks

- **Workflow recovery** — persist running workflow state so interrupted workflows can resume after restart.
- **Circuit breaker** — disable engines after N consecutive failures, re-enable after cooldown.
- **Agent-to-agent subscriptions** — pub/sub pattern where sessions subscribe to topics.
- **Config schema consolidation** — three separate config representations (plugin.json, plugin.ts, types.ts) → single source of truth.
- **Integration tests** (manual): real `claude` / `codex` / Ollama binaries for live workflow tests.
- **npm publish story** — clean install path for community.
- See [ROADMAP.md](../ROADMAP.md) for the full future enhancement list.

## Conventions reminder

- English-only in code.
- Log via `StructuredLogger` (`this.log.info/warn/error(category, message, context)`).
- Throw `EngineError` with typed categories, not plain `Error`.
- ESM, strict TS, single quotes, semicolons per [AGENTS.md](../AGENTS.md).
