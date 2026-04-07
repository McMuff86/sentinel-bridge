# API Reference — sentinel-bridge

OpenClaw tools are registered under the `sb_` namespace. Shapes below match **`src/index.ts`** handlers and **`SessionManager`** return values.

---

## Configuration (`openclaw` plugin config)

| Field | Type | Description |
|-------|------|-------------|
| `engines.claude` | `EngineConfig` | CLI command, `defaultModel`, `cwd`, `env`, `enabled` |
| `engines.codex` | `EngineConfig` | Same |
| `engines.grok` | `EngineConfig` | `apiKey`, `baseUrl`, `defaultModel`; Grok is **disabled** by default until configured |
| `defaultEngine` | `"claude" \| "codex" \| "grok" \| "ollama"` | When the caller omits engine |
| `defaultModel` | string | Optional ref such as `claude/opus` or full model id |
| `defaultFallbackChain` | engine[] | Order used after **primary** when session **start** fails. Default: `["claude", "codex", "grok", "ollama"]`. Use `[]` to disable. |
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
| `engine` | no | `claude` / `codex` / `grok` / `ollama` |
| `model` | no | Model id or alias (routing below) |
| `cwd` | no | Working directory |
| `resumeSessionId` | no | Engine-specific resume id |
| `role` | no | Agent role id (e.g. `architect`, `implementer`, `reviewer`, `tester`). Sets system prompt and preferred engine/model. |

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

### `sb_session_events`

Return the last N events from the session event timeline (start, send, fail, stop, compact, rehydrate).

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | yes | Session name |
| `limit` | no | Max events to return (default 20) |

**Returns:** `{ ok, name, count, events: SessionEvent[] }`.

Each event: `{ ts, type, engine, sessionName, preview?, error? }`.

---

### `sb_session_cancel`

Cancel the current in-flight operation (send/compact) without stopping the session. The session remains active and can receive new messages.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | yes | Session name |

**Returns:** `{ ok, name, status, phase }`.

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

---

## Context (Blackboard) Tools

### `sb_context_set`

Set a key-value pair in a shared workspace context. Any session can read values set by other sessions within the same workspace.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspace` | yes | Workspace identifier |
| `key` | yes | Context key (1-128 chars) |
| `value` | yes | JSON-serializable value |
| `session` | yes | Session name writing this value |

**Returns:** `{ ok, workspace, key, entry }`.

---

### `sb_context_get`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspace` | yes | Workspace identifier |
| `key` | yes | Context key |

**Returns:** `{ ok, workspace, key, found, entry }`.

---

### `sb_context_list`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspace` | yes | Workspace identifier |

**Returns:** `{ ok, workspace, count, entries[] }`.

---

### `sb_context_clear`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspace` | yes | Workspace identifier |
| `session` | yes | Session name performing the clear |

**Returns:** `{ ok, workspace }`.

---

## Role Tools

### `sb_role_list`

List all available agent roles (built-in and custom).

**Returns:** `{ ok, roles[] }`. Each role has `id`, `name`, `description`, `systemPrompt`, optional `preferredEngine`, `preferredModel`, `tags`.

Built-in roles: `architect`, `implementer`, `reviewer`, `tester`.

---

### `sb_role_get`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `id` | yes | Role id |

**Returns:** `{ ok, role }` or throws if not found.

---

### `sb_role_register`

Register a custom agent role with system prompt and optional engine/model preferences.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `id` | yes | Unique role id |
| `name` | yes | Display name |
| `description` | yes | Role description |
| `systemPrompt` | yes | System prompt injected on session start |
| `preferredEngine` | no | Default engine for this role |
| `preferredModel` | no | Default model for this role |
| `tags` | no | String array for categorization |

**Returns:** `{ ok, role }`.

---

## Relay Tools

### `sb_session_relay`

Relay a message from one session to another. The message is sent as input to the target session.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `from` | yes | Source session name |
| `to` | yes | Target session name |
| `message` | yes | Message to relay |
| `stream` | no | Enable streaming (default: false) |

**Returns:** `{ ok, name, output, session, relayFrom, relayTo, stats }`.

---

### `sb_session_broadcast`

Broadcast a message to all active sessions except the sender. Uses `Promise.allSettled` so one failure does not block others.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `from` | yes | Source session name |
| `message` | yes | Message to broadcast |
| `exclude` | no | Session names to exclude |

**Returns:** `{ ok, from, targets[], totalTargets, succeeded, failed, results[] }`.

---

## Workflow Tools

### `sb_workflow_start`

Start a multi-step workflow defined as a DAG. Steps execute in dependency order with parallel execution where possible.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `definition` | yes | WorkflowDefinition object (see below) |

**WorkflowDefinition shape:**
```typescript
{
  id: string;
  name: string;
  description?: string;
  workspace: string;       // links to context/blackboard
  steps: [{
    id: string;
    sessionName: string;
    task: string;
    role?: string;         // agent role id
    dependsOn?: string[];  // step ids that must complete first
    engine?: EngineKind;
    model?: string;
  }]
}
```

**Returns:** `{ ok, workflow: WorkflowState }`.

---

### `sb_workflow_status`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `id` | yes | Workflow id |

**Returns:** `{ ok, workflow }` — includes step-by-step status (`pending`, `running`, `completed`, `failed`, `skipped`).

---

### `sb_workflow_cancel`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `id` | yes | Workflow id |

**Returns:** `{ ok, id, status }`. Pending steps are marked `skipped`.

---

### `sb_workflow_list`

**Returns:** `{ ok, count, workflows[] }` — summary of all workflows with progress.

---

### `sb_workflow_template`

Generate a WorkflowDefinition from a template pattern without executing it.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `pattern` | yes | `pipeline` or `fan-out-fan-in` |
| `id` | yes | Workflow id |
| `name` | yes | Workflow name |
| `workspace` | yes | Workspace for shared context |
| `steps` | yes | Array of step definitions. For fan-out-fan-in, the last step is the aggregator. |

**Returns:** `{ ok, pattern, definition }` — ready to pass to `sb_workflow_start`.

---

## Task Routing

### `sb_route_task`

Analyze a task description and recommend the best engine and model. Advisory only — does not start a session.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `task` | yes | Task description to analyze |
| `prefer` | no | `fast`, `cheap`, or `capable` |

**Returns:** `{ ok, classification, recommendedEngine, recommendedModel, confidence, reasoning, alternatives[], costTier }`.

The classifier detects: `code_generation`, `code_review`, `reasoning`, `fast_task`, `creative`, `local_private`, `general`.

---

Further architecture notes: [TECHNICAL-ARCHITECTURE.md](./TECHNICAL-ARCHITECTURE.md). Contributor onboarding and branch notes: [CONTEXT-HANDOFF.md](./CONTEXT-HANDOFF.md).
