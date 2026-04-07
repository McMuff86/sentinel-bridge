# Changelog

All notable changes to sentinel-bridge are documented here.

## [Unreleased]

### Added — Adaptive Routing (Phases 4-5, 8)
- **Thompson Sampling** — `AdaptiveRouter` with Beta distributions (Marsaglia-Tsang
  Gamma sampling, Box-Muller normal). Per engine:category pair, learns which engine
  performs best. Minimum 5 samples before activating, static fallback otherwise.
- **EMA Scoring** — Exponential Moving Average strategy (alpha=0.3) for exploitation-
  focused routing. Blended strategy: 70% EMA + 30% Thompson for balanced explore/exploit.
- **KNN Embedding Routing** — Ollama nomic-embed-text embeddings, cosine similarity,
  K-nearest-neighbor vote from successful historical queries. Ensemble strategy:
  weighted 0.3 Thompson + 0.4 EMA + 0.3 KNN. Graceful degradation when Ollama unavailable.
- **Runtime strategy switching** — `sb_routing_config` MCP tool to change strategy
  (thompson/ema/blended/knn/ensemble/static) at runtime.
- **`sb_routing_stats`** — MCP tool showing Beta parameters, EMA scores, sample counts
  per engine:category.
- **Persistence** — `RoutingStatsStore` (JSON) and `EmbeddingStore` (JSONL, 10k record cap).
- **Tool count:** 33 → 35 tools.

### Added — Engine Plugin System (Phase 2)
- **`IEngineFactory`** interface — formal contract for engine plugins with
  `engineKind`, `displayName`, `transport`, `privacyLevel`, `create()`, optional
  `healthCheck()`.
- **`EngineRegistry`** — register/create/has/get/list. 4 built-in factories
  auto-registered (Claude, Codex, Grok, Ollama).
- **`SessionManager.registerEngine(factory)`** — runtime engine registration.
- **`create-engine.ts`** refactored to thin wrapper over default registry.
- **`BuiltInEngineKind`** type alias added (non-breaking).

### Added — Outcome Signal (Phase 3)
- **Outcome tracking** — `UsageLogEntry` gains optional `outcome` ('success'/'failure'/
  'partial'), `qualityScore` (0-1), and `taskCategory` fields.
- **`getOutcomesByEngineAndCategory()`** — query method aggregating outcomes per
  engine:category bucket with average quality scores.

### Added — Loop Workflows (Phase 6)
- **`LoopConfig`** — `maxIterations`, `continueCondition` (string match),
  `convergenceKey` + `convergenceThreshold` (numeric convergence).
- **`mode: 'loop'`** on `WorkflowDefinition` — allows cyclic graphs with mandatory
  loop guards. Default `'dag'` preserves existing cycle rejection.
- **Loop evaluator** — `evaluateLoopCondition()` with string-match and convergence
  strategies. Steps reset to pending with downstream cascade on loop continuation.
- **`WorkflowStepState.iteration`** — tracks loop iteration count.

### Added — Autoresearch Template (Phase 7)
- **`researcher` and `analyst` built-in roles** — structured CONTINUE/DONE output
  signals for iterative research patterns.
- **`createAutoresearchWorkflow(config)`** — generates plan→implement[0..N]→review→
  analyze(loop) pipeline. Configurable `maxIterations`, `parallelExperiments`,
  per-role engine overrides.
- **`sb_workflow_template` pattern: 'autoresearch'** — MCP tool support with
  `objective`, `maxIterations`, `parallelExperiments` parameters.

### Added — Mission-Control Integration (Phase 9)
- **Routing endpoints** — `GET /api/sentinel/routing/stats`,
  `GET|POST /api/sentinel/routing/config` for adaptive routing management.
- **Autoresearch endpoints** — `POST /api/sentinel/autoresearch/start`,
  `GET /api/sentinel/autoresearch/status` for research workflow lifecycle.
- **RoutingWidget** — dashboard component with strategy selector and per-engine
  success rate visualisation.
- **AutoresearchPanel** — research objective input, iteration config, workflow
  status monitoring with live refresh.
- **sentinel-api.ts** — typed client functions for all new endpoints.
- **bridgeStore.ts** — Zustand actions for routing strategy and stats.

### Changed — Mission-Control BridgeView Migration
- **BridgeView** now powered entirely by sentinel-bridge API instead of
  legacy `bridge.js` routes. Engine health, sessions, and cost data all
  come from SessionManager with circuit breaker + health checker.
- **New endpoints:** `GET /api/sentinel/overview` (BridgeView-compatible),
  `GET /api/sentinel/sessions/stream` (SSE live feed).
- **Ollama visible and enabled** in BridgeView with gemma4 as default model.

### Added — MCP Server
- **Model Context Protocol server** — all 33 tools exposed via MCP (JSON-RPC
  2.0 over stdio). LLM agents (Claude Code, Cursor, etc.) can use sentinel-bridge
  tools as native tool calls — no HTTP workarounds needed.
- **Zero dependencies** — MCP protocol implemented directly with Node.js stdin/stdout.
- **Entry point:** `node dist/mcp/index.js` or `npm run mcp` or `sentinel-bridge-mcp` (bin).
- **Setup:** `claude mcp add sentinel-bridge -- node dist/mcp/index.js`

### Added — Backpressure & Session Queue
- **Priority session queue** — when `maxConcurrentSessions` is reached, new
  session starts wait in a queue instead of being rejected. Three priority
  levels: `high`, `normal`, `low`. Configurable `maxDepth` (default: 20)
  and `timeoutMs` (default: 2 min).
- **`sb_queue_status`** tool — shows queue depth and priority breakdown.
- **Auto-release** — when a session stops, the next queued session is released.
- **Graceful shutdown** — all queued entries rejected on `dispose()`.
- **Tool count:** 32 → 33 tools.

### Added — Health Checks
- **Periodic engine health probes** — `HealthChecker` module probes all 4 engines:
  CLI engines via PATH lookup, Grok via `/models` API ping, Ollama via root HTTP ping.
  Configurable `intervalMs` (default: 2 min) and `probeTimeoutMs` (default: 5s).
- **`sb_health_check`** tool — run health checks on-demand, starts periodic background
  checks. Results include `healthy`, `latencyMs`, `checkedAt`, `error`.
- **`sb_engine_status` enriched** — now includes health check results alongside
  circuit breaker state.
- **Circuit breaker integration** — healthy probes record success (help close
  half-open circuits), but unhealthy probes do NOT record failure (health checks
  inform, they don't penalize).
- **Tool count:** 31 → 32 tools.

### Added — Workflow Recovery
- **Workflow checkpointing** — workflow state is persisted to disk after each
  step completion/failure via `WorkflowStore`. Interrupted workflows (plugin
  restart) are detectable via `listInterrupted()`.
- **`sb_workflow_resume`** — resume interrupted or running workflows. Steps that
  were mid-flight are reset to pending and re-executed; completed steps are
  preserved.
- **`interrupted` status** — new `WorkflowStatus` value for workflows that were
  running when the plugin stopped.
- **Tool count:** 30 → 31 tools.

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
