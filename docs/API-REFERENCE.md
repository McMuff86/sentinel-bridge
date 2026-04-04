# API Reference — sentinel-bridge

All tools are registered under the `sb_` namespace to avoid collisions with other OpenClaw plugins.

---

## Tools

### sb_session_start

Start a new coding agent session with a specific engine.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | string | no | auto-generated | Session name |
| `cwd` | string | no | `~` | Working directory |
| `engine` | `"claude" \| "codex" \| "grok"` | no | `"claude"` | Engine to use |
| `model` | string | no | engine default | Model identifier or alias |
| `permissionMode` | string | no | `"acceptEdits"` | Claude-specific: permission handling |
| `effort` | `"low" \| "medium" \| "high" \| "max" \| "auto"` | no | `"auto"` | Effort/thinking level |
| `maxTurns` | number | no | — | Max agent loop turns |
| `maxBudgetUsd` | number | no | — | Spending cap (USD) |
| `systemPrompt` | string | no | — | Override system prompt |
| `appendSystemPrompt` | string | no | — | Append to system prompt |
| `fallbackEngine` | string | no | — | Engine to fall back to on failure |
| `resumeSessionId` | string | no | — | Resume a previous session by ID |

**Returns:**
```json
{
  "ok": true,
  "name": "claude-swift-falcon",
  "engine": "claude",
  "model": "claude-sonnet-4-6",
  "cwd": "/home/user/project",
  "created": "2026-04-04T01:00:00.000Z"
}
```

---

### sb_session_send

Send a message to an active session and get the response.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | string | **yes** | — | Session name |
| `message` | string | **yes** | — | Message to send |
| `effort` | string | no | session default | Override effort for this message |
| `timeout` | number | no | 300000 | Timeout in ms |

**Returns:**
```json
{
  "ok": true,
  "output": "I've created the file...",
  "sessionId": "abc-123",
  "stats": {
    "turns": 3,
    "tokensIn": 1500,
    "tokensOut": 800,
    "costUsd": 0.045
  }
}
```

---

### sb_session_stop

Stop an active session and clean up engine resources.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | **yes** | Session name |

**Returns:** `{ "ok": true }`

---

### sb_session_list

List all active sessions with summary info.

**Parameters:** None

**Returns:**
```json
{
  "ok": true,
  "sessions": [
    {
      "name": "claude-swift-falcon",
      "engine": "claude",
      "model": "claude-sonnet-4-6",
      "cwd": "/home/user/project",
      "created": "2026-04-04T01:00:00.000Z",
      "isReady": true,
      "isBusy": false,
      "isPaused": false
    }
  ]
}
```

---

### sb_session_status

Get detailed status of a single session including token counts, cost, and context usage.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | **yes** | Session name |

**Returns:**
```json
{
  "ok": true,
  "name": "claude-swift-falcon",
  "engine": "claude",
  "model": "claude-sonnet-4-6",
  "isReady": true,
  "isBusy": false,
  "isPaused": false,
  "stats": {
    "turns": 12,
    "toolCalls": 8,
    "toolErrors": 0,
    "tokensIn": 45000,
    "tokensOut": 12000,
    "cachedTokens": 30000,
    "costUsd": 0.85,
    "subscriptionCovered": true,
    "contextPercent": 28,
    "uptime": 3600
  }
}
```

---

### sb_session_compact

Compact a session's context window by summarizing history.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | **yes** | Session name |
| `summary` | string | no | Custom summary for compaction |

**Returns:** `{ "ok": true }`

---

### sb_engine_list

List available engines and their readiness status.

**Parameters:** None

**Returns:**
```json
{
  "ok": true,
  "engines": [
    {
      "type": "claude",
      "available": true,
      "binary": "/usr/local/bin/claude",
      "authMethod": "subscription",
      "authValid": true
    },
    {
      "type": "codex",
      "available": true,
      "binary": "/usr/local/bin/codex",
      "authMethod": "apiKey",
      "authValid": true
    },
    {
      "type": "grok",
      "available": true,
      "binary": null,
      "authMethod": "apiKey",
      "authValid": false,
      "note": "XAI_API_KEY not set"
    }
  ]
}
```

---

### sb_model_list

List available models across all engines with pricing info.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `engine` | string | no | Filter by engine |

**Returns:**
```json
{
  "ok": true,
  "models": [
    {
      "engine": "claude",
      "model": "claude-opus-4",
      "aliases": ["opus"],
      "pricing": { "input": 15.0, "output": 75.0, "cached": 1.5 },
      "subscriptionCovered": true
    },
    {
      "engine": "codex",
      "model": "o4-mini",
      "aliases": [],
      "pricing": { "input": 1.1, "output": 4.4 },
      "subscriptionCovered": false
    }
  ]
}
```

---

### sb_session_switch_model

Switch the model for a running session. Restarts the engine process with resume capability where supported.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | **yes** | Session name |
| `model` | string | **yes** | New model (name or alias) |

**Returns:**
```json
{
  "ok": true,
  "restarted": true,
  "name": "claude-swift-falcon",
  "model": "claude-opus-4",
  "previousModel": "claude-sonnet-4-6"
}
```

---

### sb_session_switch_engine

Switch the engine for a running session. Stops the current engine and starts a new one in the same working directory.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | **yes** | Session name |
| `engine` | `"claude" \| "codex" \| "grok"` | **yes** | New engine |
| `model` | string | no | Model for the new engine |

**Returns:**
```json
{
  "ok": true,
  "name": "claude-swift-falcon",
  "previousEngine": "claude",
  "engine": "codex",
  "model": "o4-mini"
}
```

---

### sb_cost_report

Get aggregated cost report across all sessions.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionName` | string | no | Filter to specific session |

**Returns:**
```json
{
  "ok": true,
  "sessions": [
    {
      "name": "claude-swift-falcon",
      "engine": "claude",
      "model": "claude-sonnet-4-6",
      "tokensIn": 45000,
      "tokensOut": 12000,
      "costUsd": 0.85,
      "subscriptionCovered": true,
      "actualCost": 0.0
    }
  ],
  "totals": {
    "totalCostUsd": 2.35,
    "subscriptionSavings": 0.85,
    "actualBilled": 1.50
  }
}
```

---

## Session Lifecycle

```
                    ┌─────────┐
                    │  idle   │
                    └────┬────┘
                         │ sb_session_start
                         ▼
                    ┌─────────┐
              ┌─────│  ready  │─────┐
              │     └────┬────┘     │
              │          │ send     │ stop
              │          ▼          │
              │     ┌─────────┐    │
              │     │  busy   │    │
              │     └────┬────┘    │
              │          │ done    │
              │          ▼          │
              │     ┌─────────┐    │
              │     │  ready  │────┘
              │     └────┬────┘
              │          │ TTL expires / stop
              │          ▼
              │     ┌─────────┐
              └────▶│ stopped │
                    └─────────┘
```

### States

| State | Description |
|-------|-------------|
| **idle** | No session exists |
| **ready** | Engine is initialized, accepting messages |
| **busy** | Engine is processing a message |
| **paused** | Session is paused (messages rejected until resumed) |
| **stopped** | Session terminated, resources cleaned up |

### Session Persistence

When a Claude session is stopped, its `sessionId` is persisted to `~/.openclaw/sentinel-sessions.json`. This enables resuming the conversation later via `resumeSessionId` parameter in `sb_session_start`.

Codex and Grok sessions are not resumable — their "persistence" is the working directory state.

---

## Engine Management

### Engine Selection Logic

```
User specifies engine?
  → Yes: use specified engine
  → No: use config.defaultEngine (default: "claude")

User specifies model?
  → Yes: resolve alias → determine compatible engine if not specified
  → No: use engine's default model
```

### Model Alias Resolution

| Alias | Resolves To | Engine |
|-------|-------------|--------|
| `opus` | `claude-opus-4` | claude |
| `sonnet` | `claude-sonnet-4` | claude |
| `haiku` | `claude-haiku-4` | claude |
| `codex-mini` | `codex-mini` | codex |
| `o4-mini` | `o4-mini` | codex |
| `grok-3` | `grok-3` | grok |
| `grok-mini` | `grok-3-mini` | grok |

### Engine Auto-Detection from Model

If a user provides a model name without specifying an engine, the SessionManager infers the engine:

- `claude-*` or aliases `opus/sonnet/haiku` → ClaudeEngine
- `o4-*`, `codex-*`, `gpt-*` → CodexEngine
- `grok-*` → GrokEngine

---

## Model Routing

### Priority Order

1. **Explicit model in `sb_session_start`** — highest priority
2. **Model alias resolution** — `opus` → `claude-opus-4`
3. **Plugin config `defaultModel`** — fallback when no model specified
4. **Engine default** — Claude: `claude-sonnet-4`, Codex: `o4-mini`, Grok: `grok-3`

### Runtime Model Switching

`sb_session_switch_model` allows changing the model mid-session:

- **Claude:** Restarts CLI process with `--resume` flag to preserve conversation
- **Codex:** Next `send()` will use the new model (no restart needed)
- **Grok:** Applies immediately to next API call (conversation history preserved in-memory)

### Engine Switching

`sb_session_switch_engine` is a heavier operation:

1. Stop current engine
2. Persist any resumable state
3. Start new engine in same working directory
4. Conversation history is NOT transferred (engines have different context formats)
