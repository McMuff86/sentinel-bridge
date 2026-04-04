# sentinel-bridge

**Multi-engine coding agent for OpenClaw — route through Claude Code, Codex, and Grok.**

[![npm version](https://img.shields.io/npm/v/sentinel-bridge)](https://www.npmjs.com/package/sentinel-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

---

## Why?

As of April 2026, Anthropic bills third-party harness usage of Claude models separately — even if you already have a Claude Pro or Max subscription. Your existing plan only covers Anthropic's own tools.

**Claude Code CLI**, however, remains fully covered by the subscription. sentinel-bridge exploits this: it routes OpenClaw requests _through_ Claude Code CLI, so your subscription covers the usage. Zero additional cost.

## What It Does

sentinel-bridge is an OpenClaw plugin that exposes three coding agent engines through a unified interface:

- **Claude Code CLI** — subscription-covered, zero extra cost
- **OpenAI Codex CLI** — full Codex integration with working directory persistence
- **xAI Grok API** — Grok models via HTTP

All engines look the same to OpenClaw. Start sessions, send messages, switch models, track costs — one API for everything.

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
┌─────────────────────────────────────────────────┐
│                  OpenClaw Host                   │
│                                                  │
│  ┌─────────────────────────────────────────────┐ │
│  │            sentinel-bridge                  │ │
│  │                                             │ │
│  │  Tools (sb_*)  →  SessionManager            │ │
│  │                    ├── Session #1            │ │
│  │                    ├── Session #2            │ │
│  │                    └── ...                   │ │
│  │                                             │ │
│  │            ┌── IEngine Interface ──┐        │ │
│  │            │                       │        │ │
│  │     Claude Engine   Codex Engine   Grok     │ │
│  │            │            │        Engine     │ │
│  └────────────┼────────────┼──────────┼────────┘ │
│               │            │          │          │
└───────────────┼────────────┼──────────┼──────────┘
                │            │          │
         claude CLI     codex CLI   xAI HTTP API
        (subscription)  (API key)    (API key)
```

## Features

- **Subscription passthrough** — Claude usage via CLI costs $0 beyond your existing plan (when the CLI is authenticated)
- **Multi-engine sessions** — Claude, Codex, and Grok through one interface
- **Session persistence** — resume where the engine supports it (`resumeSessionId` for Claude); Codex leans on working directory state
- **Cost tracking** — per-session, per-engine breakdowns (informational)
- **Start fallback chain** — if the primary engine’s `start()` fails, retry other engines (`defaultFallbackChain`); see [configuration.md](docs/configuration.md)
- **Model aliases** — e.g. `opus`, `sonnet`, `codex` → resolved model ids
- **11 tools** in the `sb_*` namespace — session lifecycle, engines, routing, cost, compact

## Engines

| Engine | Transport | Auth | Cost | Status |
|--------|-----------|------|------|--------|
| **Claude** | CLI subprocess (stream-json) | Subscription OAuth | $0 (subscription-covered) | ✅ Implemented |
| **Codex** | CLI per-message (quiet mode) | `OPENAI_API_KEY` | Standard OpenAI pricing | ✅ Implemented |
| **Grok** | HTTP API (OpenAI-compatible) | `XAI_API_KEY` | Standard xAI pricing | ✅ Implemented |

### Supported Models

| Model | Aliases | Engine | Input/1M | Output/1M |
|-------|---------|--------|----------|-----------|
| claude-opus-4 | `opus` | Claude | $15.00* | $75.00* |
| claude-sonnet-4 | `sonnet` | Claude | $3.00* | $15.00* |
| claude-haiku-4 | `haiku` | Claude | — | — |
| o4-mini | — | Codex | $1.10 | $4.40 |
| codex-mini | `codex-mini` | Codex | $1.50 | $6.00 |
| grok-3 | `grok-3` | Grok | $3.00 | $15.00 |
| grok-3-mini | `grok-mini` | Grok | $0.30 | $0.50 |

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
          "defaultModel": "claude-sonnet-4"
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

## Migration Guide

Moving from direct Anthropic API usage to sentinel-bridge:

**Before** (direct API — billed separately):
```jsonc
{
  "model": "anthropic/claude-opus-4-6"
}
```

**After** (routed through Claude Code CLI — subscription-covered):
```bash
# 1. Install
npm install sentinel-bridge

# 2. Ensure Claude CLI is authenticated
claude login

# 3. Configure OpenClaw
openclaw plugins install sentinel-bridge
```

```jsonc
{
  "plugins": {
    "sentinel-bridge": {
      "defaultEngine": "claude",
      "defaultModel": "claude/opus",
      "engines": {
        "claude": { "defaultModel": "claude-opus-4-6" }
      }
    }
  }
}
```

Your requests now go through the CLI. Same models, same quality, zero additional billing.

## Tools

Registered tools (see [docs/API-REFERENCE.md](docs/API-REFERENCE.md) for parameters):

| Tool | Description |
|------|-------------|
| `sb_session_start` | Start a session (with optional start-time fallback chain) |
| `sb_session_send` | Send a message to an active session |
| `sb_session_stop` | Stop a session |
| `sb_session_list` | List sessions |
| `sb_session_status` | Session details |
| `sb_session_overview` | Aggregate overview + engine descriptors |
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
3. Write tests (`npm test`)
4. Ensure types pass (`npm run lint`)
5. Open a PR

Keep dependencies minimal — sentinel-bridge targets zero runtime dependencies beyond Node.js built-ins.

## License

[MIT](LICENSE) © 2026 Adrian Muff
