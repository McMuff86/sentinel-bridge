# Getting Started

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | ≥ 22 | Required for ESM and built-in fetch |
| **OpenClaw** | Latest | Plugin host |
| **Claude Code CLI** | Latest | For Claude engine — `npm install -g @anthropic-ai/claude-code` |
| **Codex CLI** | Latest | For Codex engine (optional) — `npm install -g @openai/codex` |

### Auth Setup

**Claude** (subscription-based, no API key needed):
```bash
claude login
```
This stores an OAuth token in `~/.claude/`. Your Claude Pro/Max subscription covers all usage through the CLI.

**Codex** (CLI auth or env-backed auth):
```bash
# if your Codex CLI is already authenticated, that's enough
# optional env-backed auth:
export OPENAI_API_KEY="sk-..."
```

**Grok** (API key):
```bash
export XAI_API_KEY="xai-..."
```

You only need auth for the engines you plan to use. Claude alone is enough to get started.

## Installation

```bash
# Install the package
npm install sentinel-bridge

# From a git clone, compile first (entry is dist/index.js)
npm run build

# Register with OpenClaw (command may vary by OpenClaw version)
openclaw plugins install sentinel-bridge
```

Before a real end-to-end test, walk through **[LIVE-VERIFICATION.md](./LIVE-VERIFICATION.md)**.

## First Run

### 1. Verify engines are available

Use the `sb_engine_list` tool to check which engines are ready:

```
sb_engine_list
```

Expected shape (fields include `id`, `available`, `authValid`, etc.):

```json
{
  "ok": true,
  "engines": [
    {
      "id": "claude",
      "available": true,
      "authMethod": "subscription-cli",
      "authValid": true
    }
  ]
}
```

### 2. Start a session

`name` is **required**.

```
sb_session_start { "name": "my-session", "engine": "claude", "model": "sonnet", "cwd": "/path/to/your/project" }
```

This starts a Claude Code CLI-backed session bound to `my-session`.

### 3. Send a message

```
sb_session_send { "name": "my-session", "message": "List all TypeScript files in this project" }
```

### 4. Check status

```
sb_session_status { "name": "my-session" }
```

Shows token usage, tracked cost metadata, and session state.

### 5. Stop when done

```
sb_session_stop { "name": "my-session" }
```

## Troubleshooting

### "claude: command not found"

The Claude Code CLI isn't installed or not in your PATH.

```bash
npm install -g @anthropic-ai/claude-code
which claude  # should print a path
```

If installed but not found, check your Node.js global bin directory is in PATH:
```bash
export PATH="$HOME/.npm-global/bin:$PATH"
```

### "codex: command not found"

Same as above, but for Codex:
```bash
npm install -g @openai/codex
```

### "XAI_API_KEY not set"

Grok engine requires an API key. Either set the environment variable:
```bash
export XAI_API_KEY="xai-..."
```

Or configure it in the plugin config (under `engines`):
```jsonc
{
  "plugins": {
    "sentinel-bridge": {
      "engines": {
        "grok": {
          "enabled": true,
          "apiKey": "xai-..."
        }
      }
    }
  }
}
```

### "Maximum concurrent session limit reached"

Default limit is **5** concurrent sessions (`DEFAULT_CONFIG`). Either stop unused sessions:
```
sb_session_list
sb_session_stop { "name": "old-session" }
```

Or increase the limit in config:
```jsonc
{
  "plugins": {
    "sentinel-bridge": {
      "maxConcurrentSessions": 12
    }
  }
}
```

### Claude session won't start after CLI update

If the Claude CLI was recently updated, re-authenticate:
```bash
claude login
```

### Session expired unexpectedly

Sessions have a configurable TTL (default: 7 days). Idle sessions are cleaned up automatically. Use **`sessionTTLMs`** (milliseconds), e.g. 24h:

```jsonc
{
  "plugins": {
    "sentinel-bridge": {
      "sessionTTLMs": 86400000
    }
  }
}
```

### Cost report shows $0 for Claude

That's correct. Claude usage through the CLI is covered by your subscription. The cost is tracked for visibility but marked as `subscriptionCovered: true`. No additional billing applies.
