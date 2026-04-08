# sentinel-bridge

**Multi-engine LLM orchestration — route prompts across Claude, Codex, Grok, and Ollama with adaptive routing, DAG workflows, and 34 MCP tools.**

[![npm version](https://img.shields.io/npm/v/sentinel-bridge)](https://www.npmjs.com/package/sentinel-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![CI](https://github.com/adrianmuff/sentinel-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/adrianmuff/sentinel-bridge/actions/workflows/ci.yml)

---

## Why?

LLM-powered coding agents are increasingly multi-provider. What stays valuable is a thin layer that can:

- **route** prompts to the right engine based on task type, cost, or learned performance,
- **orchestrate** multi-agent workflows with shared context,
- **preserve** session continuity across turns,
- **fail over** when an engine is unavailable,
- **observe** every routing decision, cost, and outcome.

`sentinel-bridge` makes that layer explicit — zero runtime dependencies, pure Node.js.

## Quick Start

### With Claude Code

```bash
npm install sentinel-bridge
npm run build

# Register as MCP server
claude mcp add sentinel-bridge -- node /path/to/sentinel-bridge/dist/mcp/index.js
```

All 34 `sb_*` tools are now available as native tool calls inside Claude Code.

### With Cursor / Windsurf

Add to your `.mcp.json` (project root or `~/.mcp.json`):

```json
{
  "mcpServers": {
    "sentinel-bridge": {
      "command": "node",
      "args": ["/path/to/sentinel-bridge/dist/mcp/index.js"]
    }
  }
}
```

Restart the editor — sentinel-bridge tools appear in the MCP tool list.

### As a library

```typescript
import { SessionManager } from 'sentinel-bridge';

const manager = new SessionManager({ defaultEngine: 'claude' });
const session = await manager.startSession({ name: 'my-task', engine: 'claude' });
const result = await manager.sendMessage('my-task', 'Explain this codebase');
```

### Standalone MCP server

```bash
npm run mcp
# or: npx sentinel-bridge-mcp
```

## What It Does

sentinel-bridge exposes four coding agent engines through one interface:

| Engine | Transport | Auth | Cost |
|--------|-----------|------|------|
| **Claude** | CLI subprocess (stream-json) | CLI auth | Subscription* |
| **Codex** | CLI per-message (quiet mode) | Codex/OpenAI CLI auth | Subscription* |
| **Grok** | HTTP API (OpenAI-compatible) | `XAI_API_KEY` | Pay-per-token |
| **Ollama** | HTTP API (SSE streaming) | None (local) | $0 (local) |

_*Tracked for visibility but covered by subscription._

All engines look the same: start sessions, send messages, switch models, route requests, and inspect state through one API.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        LLM Agent Host                            │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                     sentinel-bridge                         │  │
│  │                                                             │  │
│  │  MCP Tools (34 sb_*)  →  SessionManager (mutex-locked)      │  │
│  │                           ├── Session #1 (role: architect)  │  │
│  │                           ├── Session #2 (role: researcher) │  │
│  │                           └── ...                           │  │
│  │                                                             │  │
│  │  ┌── Orchestration Layer ─────────────────────────────────┐ │  │
│  │  │  WorkflowEngine    AdaptiveRouter   ContextStore       │ │  │
│  │  │  (DAG execution)   (4 strategies)   (blackboard)       │ │  │
│  │  │  TaskRouter         RoleRegistry    Relay (P2P)        │ │  │
│  │  │  (heuristic)        (6 built-in)    ContextEvents      │ │  │
│  │  └────────────────────────────────────────────────────────┘ │  │
│  │                                                             │  │
│  │  ┌── Adaptive Routing ────────────────────────────────────┐ │  │
│  │  │  Thompson Sampling · EMA · Blended (70E/30T) · Static  │ │  │
│  │  └────────────────────────────────────────────────────────┘ │  │
│  │                                                             │  │
│  │           ┌── IEngine / EngineRegistry ──────┐              │  │
│  │           │  4 built-in + extensible plugins  │              │  │
│  │  Claude Engine  Codex Engine  Grok Engine  Ollama Engine    │  │
│  │  (subprocess)   (per-message)  (HTTP+retry)  (HTTP+SSE)    │  │
│  └────────────────────────────────────────────────────────────┘  │
└───────────┬───────────┬───────────┬──────────┬──────────────────┘
            │           │           │          │
     claude CLI    codex CLI   xAI HTTP   Ollama HTTP
```

## Features

### Adaptive Routing (4 strategies)

sentinel-bridge learns which engine performs best for each task category:

- **Thompson Sampling** — Bayesian exploration via Beta distributions
- **EMA** — Exponential Moving Average for exploitation-focused routing
- **Blended** — 70% EMA + 30% Thompson (balanced explore/exploit)
- **Static** — Heuristic task classification (fast/cheap/capable preferences)

Switch strategies at runtime via `sb_routing_config`. View stats via `sb_routing_stats`.

> **Experimental:** KNN embedding routing and ensemble strategy are available in `src/experimental/` but not yet wired into the core routing pipeline.

### Engine Plugin System

Register custom engines at runtime:

```typescript
manager.registerEngine({
  engineKind: 'my-engine',
  displayName: 'My Custom Engine',
  transport: 'http',
  privacyLevel: 'cloud',
  create: (config) => new MyEngine(config),
});
```

4 built-in factories (Claude, Codex, Grok, Ollama) + unlimited custom engines via `IEngineFactory`.

### Multi-Agent Orchestration

- **Workflow DAG** — multi-step workflows with dependency resolution, parallel execution, step-level loop iterations with convergence detection
- **Autoresearch template** — plan → implement[0..N] → review → analyze(loop) pipeline for iterative research
- **Shared context (blackboard)** — workspace-scoped key-value store for cross-session data
- **Agent roles** — 6 built-in roles (Architect, Implementer, Reviewer, Tester, Researcher, Analyst) + custom roles
- **Message relay** — session-to-session messaging and broadcast

### Multi-Engine Sessions

- **Routing layer** — model aliases, engine inference, capability-based selection, configurable fallback chains
- **Session continuity** — resume where the engine supports it
- **Error categorization** — typed `EngineError` with categories and `retriable` flag
- **Retry logic** — exponential backoff with `Retry-After` support
- **Streaming** — SSE streaming with `onChunk` callback

### Production Quality

- **Circuit breaker** — per-engine failure tracking (closed → open → half-open), auto-disable
- **Health checks** — periodic engine probes with latency tracking
- **Concurrency safety** — per-session mutex
- **Persistence** — atomic JSON stores, JSONL event timelines, routing stats
- **Structured logging** — JSON entries with categories, integrates with host logger
- **Observability** — routing decisions, token usage, cost tracking, outcome recording
- **Zero runtime dependencies** — Node.js built-ins only

## Supported Models

| Model | Aliases | Engine | Input/1M | Output/1M |
|-------|---------|--------|----------|-----------|
| claude-opus-4-6 | `opus` | Claude | $15.00* | $75.00* |
| claude-sonnet-4-5 | `sonnet` | Claude | $3.00* | $15.00* |
| claude-haiku-4-5 | `haiku` | Claude | — | — |
| gpt-5.4 | `codex` | Codex | $2.50 | $15.00 |
| o4-mini | — | Codex | $1.25 | $10.00 |
| grok-4-1-fast | `grok-fast` | Grok | $0.20 | $0.50 |
| grok-3 | `grok-3` | Grok | $3.00 | $15.00 |
| llama3.2 | `llama3` | Ollama | $0 | $0 |
| mistral | `mistral` | Ollama | $0 | $0 |
| deepseek-r1 | `deepseek` | Ollama | $0 | $0 |
| qwen2.5-coder | `qwen` | Ollama | $0 | $0 |
| gemma3 | `gemma` | Ollama | $0 | $0 |

_*Tracked for visibility but covered by subscription — actual cost is $0._

## Configuration

```jsonc
{
  "plugins": {
    "sentinel-bridge": {
      "defaultEngine": "claude",
      "defaultModel": "claude/sonnet",
      "defaultFallbackChain": ["claude", "codex", "grok", "ollama"],
      "maxConcurrentSessions": 5,
      "sessionTTLMs": 604800000,
      "engines": {
        "claude": {
          "command": "claude",
          "defaultModel": "claude-sonnet-4-5"
        },
        "codex": {
          "command": "codex",
          "defaultModel": "gpt-5.4"
        },
        "grok": {
          "enabled": false,
          "defaultModel": "grok-4-1-fast"
        },
        "ollama": {
          "enabled": true,
          "baseUrl": "http://localhost:11434/v1",
          "defaultModel": "llama3.2"
        }
      }
    }
  }
}
```

Full reference: [docs/configuration.md](docs/configuration.md).

## Tools (34)

See [docs/API-REFERENCE.md](docs/API-REFERENCE.md) for full parameters.

### Session Lifecycle

| Tool | Description |
|------|-------------|
| `sb_session_start` | Start a session (with optional role, fallback chain) |
| `sb_session_send` | Send a message to an active session |
| `sb_session_stop` | Stop a session |
| `sb_session_cancel` | Cancel in-flight operation without stopping |
| `sb_session_list` | List sessions |
| `sb_session_status` | Session details |
| `sb_session_overview` | Aggregate overview + engine descriptors |
| `sb_session_events` | Session event timeline (last N events) |
| `sb_compact` | Compact session context |

### Engines & Routing

| Tool | Description |
|------|-------------|
| `sb_engine_list` | List available engines |
| `sb_engine_status` | Engine health, circuit state, config |
| `sb_model_route` | Resolve model → engine |
| `sb_cost_report` | Cost aggregation |
| `sb_route_task` | Content-based routing: recommend engine/model |
| `sb_circuit_status` | Circuit breaker state for all engines |
| `sb_circuit_reset` | Reset a circuit breaker |
| `sb_health_check` | Run health probes (latency, availability) |
| `sb_routing_stats` | Adaptive routing stats (Beta params, EMA scores) |
| `sb_routing_config` | Get/set routing strategy at runtime |

### Orchestration

| Tool | Description |
|------|-------------|
| `sb_context_set` | Set key-value in shared workspace context |
| `sb_context_get` | Get value from shared context |
| `sb_context_list` | List all context entries |
| `sb_context_clear` | Clear all context entries |
| `sb_role_list` | List agent roles (built-in + custom) |
| `sb_role_get` | Get role details |
| `sb_role_register` | Register a custom agent role |
| `sb_session_relay` | Relay message between sessions |
| `sb_session_broadcast` | Broadcast to all active sessions |
| `sb_workflow_start` | Start a DAG workflow |
| `sb_workflow_status` | Workflow progress |
| `sb_workflow_resume` | Resume interrupted workflow |
| `sb_workflow_cancel` | Cancel running workflow |
| `sb_workflow_list` | List all workflows |
| `sb_workflow_template` | Generate workflow from template (pipeline, fan-out, autoresearch) |

## Documentation

- [Getting Started](docs/getting-started.md)
- [Configuration Reference](docs/configuration.md)
- [API Reference](docs/API-REFERENCE.md)
- [Technical Architecture](docs/TECHNICAL-ARCHITECTURE.md)
- [Live verification checklist](docs/LIVE-VERIFICATION.md)
- [Context handoff (agents)](docs/CONTEXT-HANDOFF.md)
- [Roadmap](ROADMAP.md)
- [Changelog](CHANGELOG.md)

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Write tests (`npx vitest run`)
4. Ensure types pass (`npm run lint`)
5. Open a PR — CI runs lint, test, and build automatically

Keep dependencies minimal — sentinel-bridge targets zero runtime dependencies beyond Node.js built-ins.

## License

[MIT](LICENSE) © 2026 Adrian Muff
