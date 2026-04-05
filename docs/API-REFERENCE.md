# API Reference — sentinel-bridge

OpenClaw tools are registered under the `sb_` namespace. Shapes below match **`src/index.ts`** handlers and **`SessionManager`** return values.

---

## Configuration (`openclaw` plugin config)

| Field | Type | Description |
|-------|------|-------------|
| `engines.claude` | `EngineConfig` | CLI command, `defaultModel`, `cwd`, `env`, `enabled` |
| `engines.codex` | `EngineConfig` | Same |
| `engines.grok` | `EngineConfig` | `apiKey`, `baseUrl`, `defaultModel`; Grok is **disabled** by default until configured |
| `defaultEngine` | `"claude" \| "codex" \| "grok"` | When the caller omits engine |
| `defaultModel` | string | Optional ref such as `claude/opus` or full model id |
| `defaultFallbackChain` | engine[] | Order used after **primary** when session **start** fails. Default: `["claude", "codex", "grok"]`. Use `[]` to disable. |
| `maxConcurrentSessions` | number | Cap active sessions |
| `sessionTTLMs` | number | Idle TTL before expiry sweep |
| `cleanupIntervalMs` | number | Expiry sweep interval |

Internal `SessionManager` config maps `sessionTTLMs` → `ttlMs` (see `toSessionManagerConfig` in `src/index.ts`).

---

## Tools

### `sb_session_start`

Starts a session. If the primary engine’s `start()` fails, retries along **`defaultFallbackChain`** (see above). `resumeSessionId` is only applied to the **first** attempt.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | yes | Session name |
| `engine` | no | `claude` / `codex` / `grok` |
| `model` | no | Model id or alias (routing below) |
| `cwd` | no | Working directory |
| `resumeSessionId` | no | Engine-specific resume id |

**Returns:** `{ ok: true, session: { ... } }` — serialized `SessionInfo` (id, name, engine, model, status, costs, tokenCount, paths, engine state, lastError, routing, etc.).

---

### `sb_session_send`

**Parameters:** `name`, `message` (required).  
**Returns:** `{ ok, name, output, session, sessionId, routing, stats }`.

---

### `sb_session_stop`

**Parameters:** `name`.  
**Returns:** `{ ok, name, status }`.

---

### `sb_session_list`

**Returns:** `{ ok, sessions: SessionInfo[] }`.

---

### `sb_session_status`

**Parameters:** `name`.  
**Returns:** `{ ok, session }` or throws if missing.

---

### `sb_session_overview`

**Returns:** `{ ok, overview, engines }` — aggregate counts/costs plus per-engine descriptors.

---

### `sb_engine_list` / `sb_engine_status`

List or inspect engine readiness (binary on PATH for CLIs, API key for Grok).

---

### `sb_model_route`

**Parameters:** `model` (required), `engine` (optional preference).  
**Returns:** resolved `model`, `engine`, `subscriptionCovered`, `source`, plus `available` / `healthy` from descriptor.

---

### `sb_cost_report`

**Parameters:** optional `since` (ISO date string).  
**Returns:** `{ ok, report }` with per-engine breakdown.

---

### `sb_compact`

**Parameters:** `name`, optional `summary`.  
**Returns:** compaction result + session snapshot (`compacted` field).

---

## Model routing

### Explicit engine prefix

`claude/...`, `codex/...` or `openai/...`, `grok/...` or `xai/...` selects the engine; the remainder is the model path.

### Auto-detection (no prefix)

Examples: `claude-*`, `opus`, `sonnet`, `haiku` → **Claude**; `gpt-*`, `codex`, `o4-*` → **Codex**; `grok-*`, `grok` → **Grok**.

### Alias map (high level)

Defined in `src/routing/model-aliases.ts`. Examples:

| Alias / pattern | Resolves toward | Engine |
|-----------------|-----------------|--------|
| `opus` | `claude-opus-4-6` | claude |
| `sonnet` | `claude-sonnet-4-5` | claude |
| `haiku` | `claude-haiku-4` | claude |
| `codex` | `gpt-5.4` | codex |
| `grok-3` | `grok-3` | grok |

Exact keys include additional synonyms (e.g. `grok-4-1-fast`); see source for the full map.

### Priority

1. Explicit `engine` + `model` (validated for consistency).  
2. Model string (prefix, inference, aliases).  
3. `defaultModel` / `defaultEngine` from config.

---

## Fallback chain (start only)

1. Resolve **primary** engine + model like a normal `startSession`.  
2. Build order: **primary first**, then `defaultFallbackChain` entries, skipping duplicates.  
3. On failure, **`stop()`** the failed engine best-effort, then try the next engine using that engine’s **default route** (`resolveDefaultRoute`), not the user’s Claude-only alias (so `opus` does not get forced onto Codex).  
4. If all attempts fail, the **last** error is rethrown.

---

## Session status values

`active` | `stopped` | `expired` | `error` — see `SessionManager` and engine `status()` snapshots.

---

## Routing output

Session payloads now include both:

- `routingTrace` → full structured trace
- `routing` → compact human-friendly summary

Use `routing` for UI/status surfaces and `routingTrace` for debugging.

Further architecture notes: [TECHNICAL-ARCHITECTURE.md](./TECHNICAL-ARCHITECTURE.md). Contributor onboarding and branch notes: [CONTEXT-HANDOFF.md](./CONTEXT-HANDOFF.md).
