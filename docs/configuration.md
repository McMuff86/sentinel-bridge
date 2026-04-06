# Configuration reference — sentinel-bridge

Authoritative TypeScript types: **`src/plugin.ts`** (`SentinelBridgeConfig`, `EngineConfig`).  
OpenClaw passes this object to `getConfig()`; `src/index.ts` merges it with `DEFAULT_CONFIG`.

## Shape (nested `engines`)

Engine-specific options **must** live under `engines.claude`, `engines.codex`, and `engines.grok` — not at the top level next to `defaultEngine`.

```jsonc
{
  "plugins": {
    "sentinel-bridge": {
      "defaultEngine": "claude",
      "defaultModel": "claude/opus",
      "defaultFallbackChain": ["claude", "codex", "grok"],
      "maxConcurrentSessions": 5,
      "sessionTTLMs": 604800000,
      "cleanupIntervalMs": 3600000,

      "engines": {
        "claude": {
          "command": "claude",
          "defaultModel": "claude-opus-4-6",
          "enabled": true,
          "cwd": "/path/to/project",
          "args": [],
          "env": {}
        },
        "codex": {
          "command": "codex",
          "defaultModel": "gpt-5.4",
          "enabled": true,
          "env": {
            "OPENAI_API_KEY": "sk-..."
          }
        },
        "grok": {
          "enabled": false,
          "defaultModel": "grok-4-1-fast",
          "apiKey": "xai-...",
          "baseUrl": "https://api.x.ai/v1"
        }
      }
    }
  }
}
```

## Global options

| Option | Type | Default (code) | Description |
|--------|------|----------------|-------------|
| `defaultEngine` | `"claude" \| "codex" \| "grok"` | `"claude"` | When `sb_session_start` omits `engine` |
| `defaultModel` | `string` | see `DEFAULT_CONFIG` | Model ref when none passed to start |
| `defaultFallbackChain` | engine[] | `["claude","codex","grok"]` | After **primary**, retry `start()` on these engines. `[]` = off |
| `maxConcurrentSessions` | `number` | `5` | Active session cap |
| `sessionTTLMs` | `number` | 7 days | Idle TTL **milliseconds** |
| `cleanupIntervalMs` | `number` | 1 hour | Expiry sweep interval **milliseconds** |

## Per-engine options (`engines.*`)

| Option | Type | Description |
|--------|------|-------------|
| `command` | `string` | CLI binary (Claude/Codex); Grok ignores |
| `args` | `string[]` | Extra CLI args |
| `defaultModel` | `string` | Default model id for this engine |
| `cwd` | `string` | Default working directory for sessions |
| `env` | `object` | Extra env for subprocess (e.g. `OPENAI_API_KEY`) |
| `enabled` | `boolean` | `false` disables engine + CLI backend registration |
| `apiKey` | `string` | Grok: xAI key (or use `XAI_API_KEY`) |
| `baseUrl` | `string` | Grok API base |

**Note:** Pricing overrides and some fields mentioned in older docs are **not** read from plugin config today; cost logic uses engine internals / defaults.

**Deep merge:** Engine `env` objects are deep-merged with defaults. If you set `engines.claude.command` in your override, the default `env` values are preserved (not wiped). Other per-engine fields use shallow spread — the override wins.

## Model routing

Aliases, prefixes (`claude/...`), and fallback behaviour are documented in [API-REFERENCE.md](./API-REFERENCE.md).

## Environment variables

| Variable | Used by |
|----------|---------|
| `OPENAI_API_KEY` | Codex CLI (optional env-backed auth if not using existing CLI login) |
| `XAI_API_KEY` | Grok (if `apiKey` not set) |

Claude uses CLI auth (`claude login`). Codex can use existing CLI auth and may also honor env-backed auth depending on host setup.

## Live testing

See [LIVE-VERIFICATION.md](./LIVE-VERIFICATION.md).
