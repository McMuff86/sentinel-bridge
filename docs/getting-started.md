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

**Codex** (API key):
```bash
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

# Register with OpenClaw
openclaw plugins install sentinel-bridge
```

## First Run

### 1. Verify engines are available

Use the `sb_engine_list` tool to check which engines are ready:

```
sb_engine_list
```

Expected output:
```json
{
  "ok": true,
  "engines": [
    {
      "type": "claude",
      "available": true,
      "authMethod": "subscription",
      "authValid": true
    }
  ]
}
```

### 2. Start a session

```
sb_session_start { "engine": "claude", "cwd": "/path/to/your/project" }
```

This spawns a Claude Code CLI subprocess in your project directory. The session name is auto-generated (e.g., `claude-swift-falcon`).

### 3. Send a message

```
sb_session_send { "name": "claude-swift-falcon", "message": "List all TypeScript files in this project" }
```

### 4. Check status

```
sb_session_status { "name": "claude-swift-falcon" }
```

Shows token usage, cost (marked as subscription-covered for Claude), and session state.

### 5. Stop when done

```
sb_session_stop { "name": "claude-swift-falcon" }
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

Or configure it in the plugin config:
```jsonc
{
  "plugins": {
    "sentinel-bridge": {
      "grok": {
        "apiKey": "xai-..."
      }
    }
  }
}
```

### "Maximum concurrent session limit reached"

Default limit is 8 concurrent sessions. Either stop unused sessions:
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

Sessions have a configurable TTL (default: 7 days). Idle sessions are cleaned up automatically. To adjust:
```jsonc
{
  "plugins": {
    "sentinel-bridge": {
      "sessionTtlMinutes": 1440  // 24 hours
    }
  }
}
```

### Cost report shows $0 for Claude

That's correct. Claude usage through the CLI is covered by your subscription. The cost is tracked for visibility but marked as `subscriptionCovered: true`. No additional billing applies.
