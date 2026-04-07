# sentinel-bridge

**Multi-engine routing and session orchestration for OpenClaw — Claude, Codex, Grok, and Ollama behind one bridge.**

[![npm version](https://img.shields.io/npm/v/sentinel-bridge)](https://www.npmjs.com/package/sentinel-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

---

## Why?

OpenClaw is increasingly multi-provider and multi-runtime. What stays valuable is not a one-off billing workaround, but a thin layer that can:

- route sessions to the right engine,
- preserve continuity across turns,
- fail over when an engine is unavailable,
- keep provider-specific quirks out of higher-level orchestration.

`sentinel-bridge` exists to make that layer explicit.

## What It Does

sentinel-bridge is an OpenClaw plugin that exposes four coding agent engines through one interface:

- **Claude Code CLI** — CLI-backed Claude sessions
- **OpenAI Codex CLI** — Codex sessions with working-directory continuity
- **xAI Grok API** — HTTP-backed Grok sessions
- **Ollama** — Local LLM inference with streaming support (no API key required)

All engines look the same to OpenClaw. Start sessions, send messages, switch models, route requests, and inspect session state through one API.

## Quick Start

```bash
npm install sentinel-bridge
npm run build   # from a git checkout; npm package should ship dist/
openclaw plugins install sentinel-bridge   # exact command depends on your OpenClaw version
```

```jsonc
// openclaw config — engine blocks must be under "engines"
{
  "plugins": {
    "sentinel-bridge": {
      "defaultEngine": "claude",
      "engines": {
        "claude": { "command": "claude", "defaultModel": "claude-opus-4-6" }
      }
    }
  }
}
```

Ensure **`claude login`** (or current Anthropic CLI auth) succeeded on the host. For a repeatable live smoke test, use [docs/LIVE-VERIFICATION.md](docs/LIVE-VERIFICATION.md).

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          OpenClaw Host                            │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                      sentinel-bridge                         │  │
│  │                                                              │  │
│  │  Tools (30 sb_*)  →  SessionManager (mutex-locked)           │  │
│  │                       ├── Session #1 (role: architect)       │  │
│  │                       ├── Session #2 (role: implementer)     │  │
│  │                       └── ...                                │  │
│  │                                                              │  │
│  │  ┌── Orchestration Layer ──────────────────────────────────┐ │  │
│  │  │  WorkflowEngine   RoleRegistry   ContextStore  Relay    │ │  │
│  │  │  (DAG executor)   (4 built-in)   (blackboard)  (P2P)   │ │  │
│  │  │  TaskRouter        RoleStore     ContextEvents          │ │  │
│  │  │  (heuristic)       (persistent)  (JSONL audit)          │ │  │
│  │  └─────────────────────────────────────────────────────────┘ │  │
│  │                                                              │  │
│  │            ┌── IEngine Interface ──────────────┐             │  │
│  │            │                                   │             │  │
│  │  Claude Engine  Codex Engine  Grok Engine  Ollama Engine     │  │
│  │  (subprocess)   (per-message)  (HTTP+retry)  (HTTP+SSE)     │  │
│  │                                                              │  │
│  │  ┌──────────────────────────────────────────────────────┐   │  │
│  │  │  SessionStore   EventStore   StructuredLog  Tracking │   │  │
│  │  │  (atomic JSON)  (JSONL)      (JSON→logger)  (JSONL)  │   │  │
│  │  └──────────────────────────────────────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                   │
└───────────┬───────────┬───────────┬──────────┬───────────────────┘
            │           │           │          │
     claude CLI    codex CLI   xAI HTTP   Ollama HTTP
    (subscription) (subscription) (API key)   (local)
```

## Features

### Multi-Engine Sessions
- **Four engines** — Claude, Codex, Grok, and Ollama through one interface
- **Routing layer** — model aliases, engine inference, capability-based primary selection, configurable start fallback chains, and routing trace metadata
- **Session continuity** — resume where the engine supports it (`resumeSessionId` for Claude); Codex leans on working directory state
- **Error categorization** — typed `EngineError` with categories (`rate_limited`, `timeout`, `unavailable`, `auth_expired`, etc.) and `retriable` flag
- **Retry logic** — Grok (3 retries) and Ollama (2 retries) with exponential backoff, respects `Retry-After`
- **Streaming** — SSE streaming with `onChunk` callback for Ollama and Grok engines

### Multi-Agent Orchestration
- **Shared context (blackboard)** — workspace-scoped key-value store for cross-session data sharing
- **Agent roles** — 4 built-in roles (Architect, Implementer, Reviewer, Tester) with system prompt injection and engine/model preferences; custom roles via `sb_role_register`
- **Message relay** — send output of one session as input to another; broadcast to all active sessions
- **Workflow DAG** — define multi-step workflows with dependency resolution; parallel execution where possible; pipeline and fan-out/fan-in templates
- **Content-based routing** — heuristic task classifier recommends best engine/model based on task description; supports `fast`, `cheap`, `capable` preferences

### Production Quality
- **Concurrency safety** — per-session mutex serialises send/stop/compact; rehydration deduplication
- **Persistence** — sessions survive plugin restarts via atomic JSON store writes; JSONL event timeline per session
- **Structured logging** — JSON log entries with level, category, session context; integrates with OpenClaw's plugin logger
- **Observability** — per-session status, routing decisions, token usage, cost tracking, and event timeline
- **Circuit breaker** — per-engine failure tracking with automatic disabling (closed → open → half-open states), configurable threshold and cooldown, manual reset
- **Plugin surface** — 30 `sb_*` tools covering session lifecycle, orchestration, routing, cost, and more
- **Provider isolation** — keep CLI/API quirks inside engine adapters instead of leaking them upward

## Engines

| Engine | Transport | Auth | Cost | Status |
|--------|-----------|------|------|--------|
| **Claude** | CLI subprocess (stream-json) | CLI auth | Informational tracking | ✅ Implemented |
| **Codex** | CLI per-message (quiet mode) | Codex/OpenAI CLI auth or env-backed auth | Informational tracking | ✅ Implemented |
| **Grok** | HTTP API (OpenAI-compatible) | `XAI_API_KEY` | Informational tracking | ✅ Implemented |
| **Ollama** | HTTP API (OpenAI-compatible, SSE streaming) | None (local) | $0 (local inference) | ✅ Implemented |

### Supported Models

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

Use **`sessionTTLMs`** and **`cleanupIntervalMs`** (milliseconds), nested **`engines.{claude,codex,grok,ollama}`**, and optional **`defaultFallbackChain`**. Example:

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

## Integration Direction

The durable value of sentinel-bridge is **not** “subscription bypass.”
It is:

- a stable routing layer,
- provider adapters with one common interface,
- explicit fallback behaviour,
- session continuity across heterogeneous engines,
- observable routing decisions.

That makes it useful even when OpenClaw itself gains stronger native provider support.

## Current internal shape

The codebase is split into focused modules:

- `src/orchestration/*` — multi-agent orchestration layer:
  - `workflow-engine.ts` / `workflow-types.ts` / `workflow-templates.ts` — DAG execution, step coordination, pipeline/fan-out templates
  - `roles.ts` / `role-store.ts` — agent role registry (4 built-in + custom), persistent storage
  - `context-store.ts` / `context-events.ts` — shared blackboard (atomic JSON), JSONL audit trail
  - `relay.ts` — session-to-session message relay and broadcast types
  - `task-classifier.ts` / `task-router.ts` / `cost-tiers.ts` — content-based routing heuristics
- `src/routing/*` — model aliases, model resolution, fallback expansion, routing trace, capability hints
- `src/engines/*` — engine adapters (Claude CLI, Codex CLI, Grok HTTP, Ollama HTTP/SSE) + engine factory + shared utilities
- `src/sessions/*` — session store (atomic JSON), event store (JSONL), session mutex, cleanup, info shaping
- `src/session-manager.ts` — central orchestrator (sessions, context, roles, workflows, relay)
- `src/errors.ts` — `EngineError` with typed categories and retry metadata
- `src/logging.ts` — `StructuredLogger` with JSON entries, categories, external logger integration
- `src/tracking.ts` — usage tracking with JSONL logging
- `src/plugin.ts` — plugin metadata, config types, defaults

## Tools (30)

Registered tools (see [docs/API-REFERENCE.md](docs/API-REFERENCE.md) for full parameters):

### Session Lifecycle

| Tool | Description |
|------|-------------|
| `sb_session_start` | Start a session (with optional role, fallback chain) |
| `sb_session_send` | Send a message to an active session |
| `sb_session_stop` | Stop a session |
| `sb_session_cancel` | Cancel in-flight operation without stopping the session |
| `sb_session_list` | List sessions |
| `sb_session_status` | Session details |
| `sb_session_overview` | Aggregate overview + engine descriptors |
| `sb_session_events` | Session event timeline (last N events) |
| `sb_compact` | Compact session context (engine-specific) |

### Engines & Routing

| Tool | Description |
|------|-------------|
| `sb_engine_list` / `sb_engine_status` | Engine health / PATH / API key |
| `sb_model_route` | Resolve model → engine |
| `sb_cost_report` | Cost aggregation |
| `sb_route_task` | Content-based routing: analyze task → recommend engine/model |
| `sb_circuit_status` | Show circuit breaker state for all engines |
| `sb_circuit_reset` | Manually reset a circuit breaker to re-enable an engine |

### Orchestration

| Tool | Description |
|------|-------------|
| `sb_context_set` | Set a key-value pair in shared workspace context |
| `sb_context_get` | Get a value from shared context |
| `sb_context_list` | List all entries in a workspace context |
| `sb_context_clear` | Clear all entries in a workspace |
| `sb_role_list` | List available agent roles (built-in + custom) |
| `sb_role_get` | Get role details |
| `sb_role_register` | Register a custom agent role |
| `sb_session_relay` | Relay a message from one session to another |
| `sb_session_broadcast` | Broadcast a message to all active sessions |
| `sb_workflow_start` | Start a multi-step workflow (DAG) |
| `sb_workflow_status` | Get workflow progress |
| `sb_workflow_cancel` | Cancel a running workflow |
| `sb_workflow_list` | List all workflows |
| `sb_workflow_template` | Generate a workflow definition from a template |

## Documentation

- [Getting Started](docs/getting-started.md)
- [Configuration Reference](docs/configuration.md)
- [API Reference](docs/API-REFERENCE.md)
- [Technical Architecture](docs/TECHNICAL-ARCHITECTURE.md)
- [Live verification checklist](docs/LIVE-VERIFICATION.md)
- [Context handoff (agents)](docs/CONTEXT-HANDOFF.md)
- [Roadmap](ROADMAP.md)

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Write tests (`npx vitest run`)
4. Ensure types pass (`npm run lint`)
5. Open a PR — CI runs tests automatically on push/PR to main

Keep dependencies minimal — sentinel-bridge targets zero runtime dependencies beyond Node.js built-ins.

## License

[MIT](LICENSE) © 2026 Adrian Muff
