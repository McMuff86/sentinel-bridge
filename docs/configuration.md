# Configuration Reference

sentinel-bridge is configured through OpenClaw's plugin configuration system.

## Full Config Example

```jsonc
{
  "plugins": {
    "sentinel-bridge": {
      // ── Global Settings ───────────────────────────────────
      "defaultEngine": "claude",          // "claude" | "codex" | "grok"
      "defaultModel": "claude-sonnet-4",  // default model for the default engine
      "defaultCwd": "~",                  // working directory for new sessions
      "maxConcurrentSessions": 8,         // max active sessions at once
      "sessionTtlMinutes": 10080,         // session TTL (default: 7 days)
      "cleanupIntervalMinutes": 60,       // how often to sweep expired sessions
      "fallbackEngine": "codex",          // optional: engine to use on primary failure

      // ── Claude Engine ─────────────────────────────────────
      "claude": {
        "command": "claude",              // path to claude CLI binary
        "model": "claude-sonnet-4",       // default model
        "args": [],                       // extra CLI args
        "env": {},                        // extra env vars
        "timeoutMs": 300000,              // per-message timeout (5 min)
        "pricing": {                      // override pricing (per 1M tokens)
          "inputPer1M": 3.00,
          "outputPer1M": 15.00,
          "cachedInputPer1M": 0.30
        }
      },

      // ── Codex Engine ──────────────────────────────────────
      "codex": {
        "command": "codex",               // path to codex CLI binary
        "model": "o4-mini",               // default model
        "args": [],
        "env": {
          "OPENAI_API_KEY": "sk-..."      // or use env var directly
        },
        "timeoutMs": 300000,
        "pricing": {
          "inputPer1M": 1.10,
          "outputPer1M": 4.40,
          "cachedInputPer1M": 0
        }
      },

      // ── Grok Engine ───────────────────────────────────────
      "grok": {
        "model": "grok-3",               // default model
        "apiKey": "xai-...",              // or use XAI_API_KEY env var
        "baseUrl": "https://api.x.ai/v1",// API base URL
        "timeoutMs": 300000,
        "pricing": {
          "inputPer1M": 3.00,
          "outputPer1M": 15.00,
          "cachedInputPer1M": 0
        }
      }
    }
  }
}
```

## Global Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultEngine` | `"claude" \| "codex" \| "grok"` | `"claude"` | Engine used when none is specified in `sb_session_start` |
| `defaultModel` | `string` | Engine-specific | Model used when none is specified |
| `defaultCwd` | `string` | `"~"` | Working directory for new sessions |
| `maxConcurrentSessions` | `number` | `8` | Maximum active sessions. New starts are rejected at the limit |
| `sessionTtlMinutes` | `number` | `10080` (7d) | Idle sessions expire after this duration |
| `cleanupIntervalMinutes` | `number` | `60` | How often the cleanup sweep runs |
| `fallbackEngine` | `string` | — | Engine to use when the primary fails (opt-in) |

## Engine-Specific Options

All engines share these common options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `command` | `string` | Engine name | Path to the CLI binary |
| `model` | `string` | See below | Default model for this engine |
| `args` | `string[]` | `[]` | Additional CLI arguments |
| `env` | `object` | `{}` | Additional environment variables |
| `timeoutMs` | `number` | `300000` | Per-message timeout in milliseconds |
| `pricing` | `object` | Built-in | Override token pricing (per 1M tokens) |

### Claude-Specific

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `command` | `string` | `"claude"` | Path to Claude Code CLI |
| `model` | `string` | `"claude-sonnet-4"` | Default Claude model |
| `resumeSessionId` | `string` | — | Resume a previous Claude session |

Claude uses subscription OAuth — no API key needed. Run `claude login` to authenticate.

### Codex-Specific

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `command` | `string` | `"codex"` | Path to Codex CLI |
| `model` | `string` | `"o4-mini"` | Default Codex model |
| `env.OPENAI_API_KEY` | `string` | From env | OpenAI API key |

### Grok-Specific

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | `string` | `"grok-3"` | Default Grok model |
| `apiKey` | `string` | From `XAI_API_KEY` env | xAI API key |
| `baseUrl` | `string` | `"https://api.x.ai/v1"` | API base URL |

## Multi-Model Routing

sentinel-bridge resolves models using this priority:

1. **Explicit model** in `sb_session_start` — highest priority
2. **Alias resolution** — e.g., `opus` → `claude-opus-4`
3. **Plugin config `defaultModel`** — fallback
4. **Engine default** — Claude: `claude-sonnet-4`, Codex: `o4-mini`, Grok: `grok-3`

### Model Aliases

| Alias | Resolves To | Engine |
|-------|-------------|--------|
| `opus` | `claude-opus-4` | Claude |
| `sonnet` | `claude-sonnet-4` | Claude |
| `haiku` | `claude-haiku-4` | Claude |
| `codex-mini` | `codex-mini` | Codex |
| `o4-mini` | `o4-mini` | Codex |
| `grok-3` | `grok-3` | Grok |
| `grok-mini` | `grok-3-mini` | Grok |

### Auto-Detection

If you specify a model without an engine, the engine is inferred:
- `claude-*`, `opus`, `sonnet`, `haiku` → Claude
- `o4-*`, `codex-*`, `gpt-*` → Codex
- `grok-*` → Grok

## Cost Tracking

Cost is tracked per-session using the pricing table. Each `sb_session_status` and `sb_cost_report` call returns:

- **Token counts** — input, output, cached
- **Cost in USD** — computed from model pricing
- **`subscriptionCovered`** — `true` for Claude sessions (actual cost is $0)

### Pricing Overrides

Override built-in pricing for any engine:

```jsonc
{
  "claude": {
    "pricing": {
      "inputPer1M": 15.00,
      "outputPer1M": 75.00,
      "cachedInputPer1M": 1.50
    }
  }
}
```

This is useful when new models are released before sentinel-bridge updates its pricing table.

## Fallback Chain

When `fallbackEngine` is configured, sentinel-bridge handles engine failures:

```
Primary engine fails
  → Retry with exponential backoff (3 attempts: 1s, 2s, 4s)
  → If still failing + fallback configured:
      → Start session on fallback engine
      → Replay the failed message
      → Return result with fallback flag
  → If no fallback: return error
```

### Configuration

```jsonc
{
  "plugins": {
    "sentinel-bridge": {
      "defaultEngine": "claude",
      "fallbackEngine": "codex"     // Claude fails → auto-switch to Codex
    }
  }
}
```

Fallback is **opt-in only**. Without `fallbackEngine`, failures return errors directly.

### Per-Session Fallback

You can also set fallback per-session:

```
sb_session_start { "engine": "claude", "fallbackEngine": "grok" }
```

This overrides the global fallback for that specific session.

## Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | Codex | OpenAI API key for Codex engine |
| `XAI_API_KEY` | Grok | xAI API key for Grok engine |

Claude does not use an API key — it uses the OAuth token from `claude login`.
