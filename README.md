# sentinel-bridge

**Multi-engine routing and session orchestration for OpenClaw — Claude, Codex, and Grok behind one bridge.**

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

sentinel-bridge is an OpenClaw plugin that exposes three coding agent engines through one interface:

- **Claude Code CLI** — CLI-backed Claude sessions
- **OpenAI Codex CLI** — Codex sessions with working-directory continuity
- **xAI Grok API** — HTTP-backed Grok sessions

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
┌───────────────────────────────────────────────────────┐
│                     OpenClaw Host                      │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │               sentinel-bridge                     │  │
│  │                                                   │  │
│  │  Tools (sb_*)  →  SessionManager (mutex-locked)   │  │
│  │                    ├── Session #1                  │  │
│  │                    ├── Session #2                  │  │
│  │                    └── ...                        │  │
│  │                                                   │  │
│  │            ┌── IEngine Interface ──┐              │  │
│  │            │                       │              │  │
│  │     Claude Engine   Codex Engine   Grok Engine    │  │
│  │            │            │          │ (retry)      │  │
│  │                                                   │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  SessionStore   EventStore   StructuredLog  │  │  │
│  │  │  (atomic JSON)  (JSONL)      (JSON→logger)  │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
│                                                        │
└────────────┬───────────┬───────────┬──────────────────┘
             │           │           │
      claude CLI    codex CLI   xAI HTTP API
     (subscription)  (API key)    (API key)
```

## Features

- **Multi-engine sessions** — Claude, Codex, and Grok through one interface
- **Routing layer** — model aliases, engine inference, light capability-based primary selection, configurable start fallback chains, and routing trace metadata
- **Session continuity** — resume where the engine supports it (`resumeSessionId` for Claude); Codex leans on working directory state
- **Error categorization** — typed `EngineError` with categories (`rate_limited`, `timeout`, `unavailable`, `auth_expired`, etc.) and `retriable` flag for intelligent fallback decisions
- **Grok retry** — exponential backoff (up to 3 retries) for rate-limited and transient errors, respects `Retry-After`
- **Session cancel** — abort in-flight operations without destroying the session
- **Concurrency safety** — per-session mutex serialises send/stop/compact; rehydration deduplication
- **Persistence** — sessions survive plugin restarts via atomic JSON store writes; JSONL event timeline per session
- **Structured logging** — JSON log entries with level, category, session context; integrates with OpenClaw's plugin logger
- **Observability** — per-session status, routing decisions, token usage, cost tracking, and event timeline
- **Plugin surface** — 13 `sb_*` tools for session lifecycle, engines, routing, cost, compact, events, and cancel
- **Provider isolation** — keep CLI/API quirks inside engine adapters instead of leaking them upward

## Engines

| Engine | Transport | Auth | Cost | Status |
|--------|-----------|------|------|--------|
| **Claude** | CLI subprocess (stream-json) | CLI auth | Informational tracking | ✅ Implemented |
| **Codex** | CLI per-message (quiet mode) | Codex/OpenAI CLI auth or env-backed auth | Informational tracking | ✅ Implemented |
| **Grok** | HTTP API (OpenAI-compatible) | `XAI_API_KEY` | Informational tracking | ✅ Implemented |

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

_*Tracked for visibility but covered by subscription — actual cost is $0._

## Configuration

Use **`sessionTTLMs`** and **`cleanupIntervalMs`** (milliseconds), nested **`engines.{claude,codex,grok}`**, and optional **`defaultFallbackChain`**. Example:

```jsonc
{
  "plugins": {
    "sentinel-bridge": {
      "defaultEngine": "claude",
      "defaultModel": "claude/sonnet",
      "defaultFallbackChain": ["claude", "codex", "grok"],
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

- `src/routing/*` — model aliases, model resolution, fallback expansion, routing trace, capability hints
- `src/engines/*` — engine adapters (Claude CLI, Codex CLI, Grok HTTP) + engine factory + shared utilities
- `src/sessions/*` — session store (atomic JSON), event store (JSONL), session mutex, cleanup, info shaping
- `src/session-manager.ts` — orchestration facade (mutex-protected)
- `src/errors.ts` — `EngineError` with typed categories and retry metadata
- `src/logging.ts` — `StructuredLogger` with JSON entries, categories, external logger integration
- `src/tracking.ts` — usage tracking with JSONL logging
- `src/plugin.ts` — plugin metadata, config types, defaults

## Tools

Registered tools (see [docs/API-REFERENCE.md](docs/API-REFERENCE.md) for parameters):

| Tool | Description |
|------|-------------|
| `sb_session_start` | Start a session (with optional start-time fallback chain) |
| `sb_session_send` | Send a message to an active session |
| `sb_session_stop` | Stop a session |
| `sb_session_cancel` | Cancel in-flight operation without stopping the session |
| `sb_session_list` | List sessions |
| `sb_session_status` | Session details |
| `sb_session_overview` | Aggregate overview + engine descriptors |
| `sb_session_events` | Session event timeline (last N events) |
| `sb_engine_list` / `sb_engine_status` | Engine health / PATH / API key |
| `sb_model_route` | Resolve model → engine |
| `sb_cost_report` | Cost aggregation |
| `sb_compact` | Compact session context (engine-specific) |

## Documentation

- [Getting Started](docs/getting-started.md)
- [Configuration Reference](docs/configuration.md)
- [API Reference](docs/API-REFERENCE.md)
- [Live verification checklist](docs/LIVE-VERIFICATION.md)
- [Technical Architecture](docs/TECHNICAL-ARCHITECTURE.md)
- [Context handoff (agents)](docs/CONTEXT-HANDOFF.md)

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Write tests (`npx vitest run`)
4. Ensure types pass (`npm run lint`)
5. Open a PR — CI runs tests automatically on push/PR to main

Keep dependencies minimal — sentinel-bridge targets zero runtime dependencies beyond Node.js built-ins.

## License

[MIT](LICENSE) © 2026 Adrian Muff
