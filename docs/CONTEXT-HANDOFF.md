# Context handoff — sentinel-bridge

This file is for **future agents and contributors** so they can continue work without re-reading the entire tree. See also [AGENTS.md](../AGENTS.md) (style and rules), [TECHNICAL-ARCHITECTURE.md](./TECHNICAL-ARCHITECTURE.md), [API-REFERENCE.md](./API-REFERENCE.md), and **[LIVE-VERIFICATION.md](./LIVE-VERIFICATION.md)** (pre-flight checklist before real OpenClaw + CLI tests).

## What this project is

OpenClaw plugin that exposes **Claude Code CLI**, **Codex CLI**, and **Grok (HTTP API)** behind one `SessionManager`. Tools live under the `sb_*` namespace in `src/index.ts`.

The project is now being reshaped into four clear seams:
- `routing/`
- `engines/`
- `sessions/`
- `session-manager.ts` as orchestration facade

## Branch / merge situation (as of 2026-04)

- The earlier `feat/model-routing` work has been merged back into `main`.
- A cleanup/refactor pass has already landed:
  - routing extracted to `src/routing/*`
  - engine factory extracted to `src/engines/create-engine.ts`
  - session cleanup/info helpers extracted to `src/sessions/*`
  - routing trace added for session starts

If you continue from here, assume `main` is now the integration branch for the cleaner architecture.

## Key code paths

| Area | File | Notes |
|------|------|--------|
| Plugin entry | `src/index.ts` | `activate()`, tool table, `toSessionManagerConfig()` |
| Orchestration | `src/session-manager.ts` | Thin facade: session lifecycle + coordination |
| Routing | `src/routing/*` | aliases, resolution, fallback order, routing trace, capability hints |
| Sessions | `src/sessions/*` | cleanup, session info shaping, shared session record types |
| Plugin defaults | `src/plugin.ts` | `DEFAULT_CONFIG`, OpenClaw-facing config shape |
| Shared types | `src/types.ts` | `EngineKind`, `SentinelBridgeConfig`, `ModelRoute`, etc. |
| Engines | `src/engines/*.ts` | **Isolated** per engine; SessionManager instantiates them |

## Model routing (current behavior)

- **Prefix form:** `claude/...`, `codex/...` or `openai/...`, `grok/...` or `xai/...` forces engine.
- **Inference:** e.g. `claude-*`, `opus` / `sonnet` / `haiku` → Claude; `gpt-*`, `codex` → Codex; `grok-*` → Grok.
- **Aliases:** per-engine map in `src/routing/model-aliases.ts` (e.g. `opus` → `claude-opus-4-6`, `codex` → `gpt-5.4`).
- **Trace:** session start stores attempted routes in `routingTrace` for observability.

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

## Suggested next tasks

- Use `src/routing/provider-capabilities.ts` as the basis for future capability-based routing rules.
- `src/engines/grok-engine.ts` — HTTP hardening, errors, rate limits (medium).
- Align plugin default model strings with alias targets if product wants one canonical Opus id everywhere.
- Integration tests (manual): real `claude` / `codex` binaries and `XAI_API_KEY` for Grok.

## Conventions reminder

- English-only in code; log via OpenClaw `api.logger` from `index.ts` (SessionManager has no logger today).
- ESM, strict TS, single quotes, semicolons per [AGENTS.md](../AGENTS.md).
