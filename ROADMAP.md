# Roadmap — sentinel-bridge

Current state: 33 tools, 4 engines, multi-agent orchestration with workflows (with recovery), roles, shared context, relay, content-based routing, circuit breaker, health checks, backpressure queue, and MCP server. 390 tests, zero runtime dependencies. Integrated into Mission-Control via REST API layer + MCP for native agent tool access.

---

## Short-term (next iteration)

### ~~Workflow Recovery & Persistence~~ (done)
- ~~Persist running workflow state so interrupted workflows can resume after plugin restart~~
- ~~Checkpoint step outputs to disk between steps~~
- ~~`sb_workflow_resume` tool to pick up where a workflow left off~~

### ~~Circuit Breaker~~ (done)
- ~~Track consecutive failures per engine~~
- ~~Automatically disable engine after N failures (configurable threshold)~~
- ~~Re-enable after cooldown period or manual reset~~
- ~~Expose circuit state via `sb_engine_status`, `sb_circuit_status`, `sb_circuit_reset`~~

### ~~Health Checks~~ (done)
- ~~Periodic engine reachability probes (not just on start)~~
- ~~Background health check interval (configurable)~~
- ~~Feed health status into circuit breaker (success only — failures don't trip)~~
- ~~Expose last-check timestamp and latency via `sb_engine_status` + `sb_health_check`~~

### Workflow Event Integration
- Emit `workflow_started`, `workflow_step_completed`, `workflow_failed` events to session event timeline
- Enable monitoring workflows through existing `sb_session_events` infrastructure

---

## Medium-term (production hardening)

### ~~Backpressure & Queuing~~ (done)
- ~~Replace hard `maxConcurrentSessions` reject with a priority queue~~
- ~~Workflow steps that exceed session limit wait in queue instead of failing~~
- ~~Priority levels: high, normal, low~~
- ~~Configurable queue depth (default 20) and timeout (default 2 min)~~
- ~~`sb_queue_status` tool for observability~~

### Agent Subscriptions (Pub/Sub)
- Sessions subscribe to named topics
- `sb_topic_publish(topic, message)` fans out to all subscribers
- Enables event-driven coordination patterns beyond explicit relay
- Topic-based filtering for selective broadcast

### Consensus / Debate Pattern
- Multiple agents solve the same problem independently
- Aggregator session compares outputs and selects or synthesizes the best result
- Built-in workflow template: `createConsensusWorkflow(task, agentCount, aggregatorRole)`
- Useful for code review, architecture decisions, test generation

### Dynamic Re-Routing
- Mid-session engine migration when an engine degrades
- Save conversation context, start new session on different engine, replay context
- Transparent to the caller — session name stays the same

### Streaming Coordination
- Coordinated streaming across relay chains
- Stream chunks from source session through relay to target session
- Enable real-time pipeline processing

---

## Long-term (ecosystem growth)

### OpenTelemetry Integration
- Export spans for workflow execution, session lifecycle, engine calls
- Trace context propagation across relay chains
- Metrics: latency per engine, token throughput, cost rate
- Compatible with Grafana, Jaeger, Datadog

### Plugin Marketplace Readiness
- `npm publish` with clean install path
- Versioned API contract (tool schemas as part of semver)
- Migration guides between versions
- Example configurations for common setups

### Multi-Workspace Orchestration
- Workflows spanning multiple workspaces
- Cross-workspace context references
- Workspace-level access control (which sessions can write to which workspace)

### Adaptive Routing (ML-based)
- Replace keyword heuristics with lightweight classifier trained on historical task→engine→quality data
- Track which engine produced the best results for which task types
- Feedback loop: user ratings or automated quality signals feed back into routing
- Still zero runtime deps — use a simple decision tree serialized as JSON

### Engine Plugin System
- Allow third-party engine adapters without modifying sentinel-bridge core
- `IEngine` interface is already stable — formalize it as a public contract
- Engine discovery via file convention or registration API
- Candidates: Google Gemini, Mistral API, Anthropic API (direct), local llama.cpp

### Advanced Workflow Patterns
- **Conditional branching** — `if/else` steps based on upstream output analysis
- **Loops** — repeat step until quality threshold met (with max iterations)
- **Sub-workflows** — compose workflows from reusable sub-workflow definitions
- **Timeout per step** — fail step if it exceeds configurable duration
- **Manual approval gates** — pause workflow and wait for human approval before continuing

### Role Evolution
- Role performance tracking (which roles produce best results on which engines)
- Role versioning (update system prompts without breaking existing sessions)
- Role composition (combine multiple roles into a compound role)
- Community role marketplace (share and import role definitions)

---

## MCP Server (done)

All 33 tools are available as native MCP tool calls via `node dist/mcp/index.js`. Zero additional dependencies — MCP JSON-RPC 2.0 protocol implemented directly on Node.js stdio. Compatible with Claude Code, Cursor, and any MCP client.

Setup: `claude mcp add sentinel-bridge -- node dist/mcp/index.js`

## Integration: Mission-Control (done)

Sentinel-Bridge is fully integrated into Mission-Control:

- **REST API Layer:** `routes/sentinel.js` — 25+ endpoints for sessions, workflows, factory, roles, context, cost, circuit breaker, health checks, SSE streaming
- **Frontend Client:** `src/lib/sentinel-api.ts` — typed API client
- **BridgeView:** Migrated from legacy `bridge.js` to sentinel API — engine health, sessions, cost breakdown all powered by sentinel SessionManager
- **Factory Integration:** Factory-Start uses `sb_workflow_start` for DAG-based execution
- **SSE Live Feed:** `/api/sentinel/sessions/stream` pushes real-time state updates
- **Engine Toggle:** Circuit breaker reset as "enable" mechanism

Sentinel-Bridge is now integrated into Mission-Control as a local dependency (`file:../sentinel-bridge`). The integration exposes all 31 tools as REST endpoints via `routes/sentinel.js`:

- `GET /api/sentinel/status` — Bridge overview (sessions, circuits, workflows)
- `POST /api/sentinel/session/start|send|stop|relay` — Session lifecycle
- `GET /api/sentinel/engines` — Engine health + circuit breaker state
- `POST /api/sentinel/workflow/start|resume|cancel` — Workflow orchestration
- `POST /api/sentinel/route-task` — Content-based task routing
- `GET /api/sentinel/roles` — Agent role listing
- `POST /api/sentinel/context/set` — Shared context operations

**Next:** Connect Factory UI to use `sb_workflow_start` for factory runs instead of raw CLI agent spawning.

---

## Non-goals

These are explicitly out of scope for sentinel-bridge:

- **Replacing OpenClaw** — sentinel-bridge is a plugin, not a standalone orchestrator
- **Training or fine-tuning** — we route to engines, we don't train them
- **User authentication** — engine auth is delegated to CLI/API credentials on the host
- **Billing** — cost tracking is informational; actual billing is handled by engine providers
- **GUI** — sentinel-bridge is a tool-layer plugin; UI is OpenClaw's responsibility

---

## Contributing

See [AGENTS.md](AGENTS.md) for code style and conventions. Feature ideas welcome via GitHub Issues. PRs should include tests and pass `npx vitest run` + `npx tsc --noEmit`.
