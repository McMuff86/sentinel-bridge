# Changelog

All notable changes to sentinel-bridge are documented here.

## [Unreleased]

### Added — Circuit Breaker
- **Per-engine circuit breaker** — tracks consecutive failures per engine with
  three states: closed (normal), open (blocking), half-open (probing).
  Configurable `failureThreshold` (default: 5), `cooldownMs` (default: 60s),
  `halfOpenSuccessThreshold` (default: 1).
- **Automatic engine skipping** — engines with open circuits are skipped during
  fallback chain execution, preventing wasted retry attempts.
- **Manual reset** — `sb_circuit_reset` tool to re-enable a tripped engine.
- **Observability** — `sb_circuit_status` shows all circuit states;
  `sb_engine_status` now includes circuit state in response.
- **Tool count:** 28 → 30 tools.

### Added — Multi-Agent Orchestration Layer
- **Shared context (blackboard)** — workspace-scoped key-value store for
  cross-session data sharing. 4 new tools: `sb_context_set`, `sb_context_get`,
  `sb_context_list`, `sb_context_clear`. Atomic JSON persistence, JSONL audit trail.
- **Agent roles** — 4 built-in roles (Architect, Implementer, Reviewer, Tester)
  with system prompt injection and engine/model preferences. Custom roles via
  `sb_role_register`. 3 new tools: `sb_role_list`, `sb_role_get`, `sb_role_register`.
  `sb_session_start` now accepts optional `role` parameter.
- **Message relay** — session-to-session messaging via `sb_session_relay` and
  broadcast to all active sessions via `sb_session_broadcast`. Relay events
  tracked on both source and target timelines.
- **Workflow DAG** — multi-step workflow execution with dependency resolution
  and parallel execution. DAG cycle detection, failure cascading (failed step
  marks dependents as `skipped`), context propagation via blackboard. 5 new
  tools: `sb_workflow_start`, `sb_workflow_status`, `sb_workflow_cancel`,
  `sb_workflow_list`, `sb_workflow_template`. Pipeline and fan-out/fan-in templates.
- **Content-based routing** — heuristic task classifier recommends best
  engine/model. `sb_route_task` tool with `fast`/`cheap`/`capable` preferences.
- **Provider capabilities extended** — `codeStrength`, `reasoningStrength`,
  `speedTier`, `privacyLevel` fields on provider capabilities.
- **12 new source files** in `src/orchestration/`, 7 new test files (341 total tests).
- **Tool count:** 13 → 28 tools.

### Added — Prior (Error Handling & Robustness)
- **Error categorization** — `EngineError` class with typed categories
  (`unavailable`, `auth_expired`, `rate_limited`, `timeout`, `context_overflow`,
  `transient`, `cancelled`). Fallback chain and retry logic can now make
  intelligent decisions.
- **Grok retry with exponential backoff** — retriable errors (429, 5xx, timeout)
  are retried up to 3 times with exponential backoff, respecting `Retry-After`.
- **Session cancel** — `sb_session_cancel` tool aborts the current in-flight
  operation without destroying the session.
- **CI** — GitHub Actions workflow: test on push/PR to main (Node 22).
- **CHANGELOG** — this file.

### Changed
- All four engines (Claude, Codex, Grok, Ollama) now throw `EngineError` with
  proper categories instead of plain `Error`.
- `IEngine` interface gains a `cancel()` method.
- `SessionManager` gains orchestration methods (workflows, context, roles, relay).
- `SessionStartOptions` and `SessionInfo` gain optional `role` field.
- `LogCategory` extended with `context` and `orchestration`.
- `SessionEventType` extended with `system_prompt_injected` and `message_relayed`.

## [0.1.0] — 2026-04-06

### Added
- **Session-level mutex** — per-session promise-based lock serialises
  send/stop/compact to prevent race conditions.
- **Structured logging** — `StructuredLogger` with JSON entries, categories,
  and OpenClaw `api.logger` integration.
- **Atomic store writes** — write-to-temp + rename prevents data loss on crash.
- **Session name validation** — strict regex at all public API entry points
  prevents path traversal.
- **Config deep merge** — engine `env` is deep-merged so user overrides don't
  wipe defaults.
- **Expired session store cleanup** — persisted sessions that expired offline
  are purged on next sweep.
- **Event store hardening** — malformed JSONL lines skipped, auto-pruning at
  1000 events per session.
- **Rehydration deduplication** — prevents concurrent rehydration of the same
  session.

### Core (initial release)
- Three engine adapters: Claude Code CLI, Codex CLI, Grok HTTP API.
- Unified `sb_*` tool namespace (13 tools).
- Session lifecycle: start, send, stop, compact, list, status, overview.
- Routing: model aliases, `engine/model` syntax, capability-based primary
  selection, configurable fallback chain.
- Per-turn and cumulative usage/cost tracking.
- Session persistence across tool calls (`sessions.json`).
- JSONL event timeline per session.
- CLI backend registration for OpenClaw.
- Zero runtime dependencies (Node.js 22+).
