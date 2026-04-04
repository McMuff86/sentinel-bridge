# Context handoff — sentinel-bridge

This file is for **future agents and contributors** so they can continue work without re-reading the entire tree. See also [AGENTS.md](../AGENTS.md) (style and rules), [TECHNICAL-ARCHITECTURE.md](./TECHNICAL-ARCHITECTURE.md), and [API-REFERENCE.md](./API-REFERENCE.md).

## What this project is

OpenClaw plugin that exposes **Claude Code CLI**, **Codex CLI**, and **Grok (HTTP API)** behind one `SessionManager`. Tools live under the `sb_*` namespace in `src/index.ts`.

## Branch / merge situation (as of 2026-04)

- **`origin/main`** may lag; parallel work was split across branches:
  - **Claude engine live work**: local worktree `/tmp/sb-claude-engine`, branch `feat/claude-engine-live` (not in this clone by default).
  - **Codex agents**: `sb-codex-auth-v2` → `src/engines/codex-engine.ts` + tests; `sb-tracking-v2` → `src/tracking.ts` (new) + tests.
- **This branch (`feat/model-routing`)** intentionally touches **only** orchestration and docs:
  - `src/session-manager.ts` — model alias map, routing, **start-session fallback chain**
  - `src/types.ts`, `src/plugin.ts`, `src/index.ts` — config wiring + tool copy
  - `src/__tests__/session-manager.test.ts` — routing + fallback (mocked engines)
  - `docs/API-REFERENCE.md`, this file

**Merge order suggestion:** merge `main` baseline first, then this branch, then Codex/tracking branches, then Claude engine branch—resolve conflicts in engine files on the feature branches.

## Key code paths

| Area | File | Notes |
|------|------|--------|
| Plugin entry | `src/index.ts` | `activate()`, tool table, `toSessionManagerConfig()` |
| Orchestration | `src/session-manager.ts` | Sessions, TTL, `resolveModelRoute()`, `startSession()` with fallback |
| Plugin defaults | `src/plugin.ts` | `DEFAULT_CONFIG`, OpenClaw-facing config shape |
| Shared types | `src/types.ts` | `EngineKind`, `SentinelBridgeConfig`, `ModelRoute`, etc. |
| Engines | `src/engines/*.ts` | **Isolated** per engine; SessionManager instantiates them |

## Model routing (current behavior)

- **Prefix form:** `claude/...`, `codex/...` or `openai/...`, `grok/...` or `xai/...` forces engine.
- **Inference:** e.g. `claude-*`, `opus` / `sonnet` / `haiku` → Claude; `gpt-*`, `codex` → Codex; `grok-*` → Grok.
- **Aliases:** per-engine map in `MODEL_ALIASES` inside `session-manager.ts` (e.g. `opus` → `claude-opus-4-6`, `codex` → `gpt-5.4`).

## Fallback chain (current behavior)

- Config: `defaultFallbackChain` on **plugin** config (`SentinelBridgeConfig` in `plugin.ts`), mirrored in **internal** `types.SentinelBridgeConfig` as `defaultFallbackChain`.
- Default order: **`["claude", "codex", "grok"]`**.
- **`startSession` only:** if `start()` throws, the manager tries the next engine in the expanded order (primary first, then chain entries without duplicates). **`sendMessage` does not fall back** (session is already bound to one engine).
- **`defaultFallbackChain: []`** disables retries (primary only).
- **`resumeSessionId`** is passed only on the **first** attempt; later attempts omit it (wrong engine would ignore or mishandle it).
- On failed `start()`, `SessionManager` calls `engine.stop()` best-effort before propagating so the next engine attempt is clean.

## Testing

```bash
npm test
npm run lint
```

Engine unit tests under `src/__tests__/` are not all present in minimal checkouts; **session-manager** tests mock `ClaudeEngine` / `CodexEngine` / `GrokEngine` to avoid real CLI/API.

## Suggested next tasks (no overlap with reserved branches)

- `src/engines/grok-engine.ts` — HTTP hardening, errors, rate limits (medium).
- After merges: align **plugin default model** strings with alias targets if product wants one canonical Opus id everywhere.
- Integration tests (manual): real `claude` / `codex` binaries and `XAI_API_KEY` for Grok.

## Conventions reminder

- English-only in code; log via OpenClaw `api.logger` from `index.ts` (SessionManager has no logger today).
- ESM, strict TS, single quotes, semicolons per [AGENTS.md](../AGENTS.md).
