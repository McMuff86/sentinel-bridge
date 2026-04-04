# Live verification — sentinel-bridge

Use this checklist **before** you rely on the plugin in production or in your app/skill. Unit tests do not spawn real CLIs.

## 1. Preconditions

| Check | Notes |
|--------|--------|
| Node.js ≥ 22 | `node -v` |
| Build succeeds | `npm run build` → `dist/index.js` exists |
| Lint / tests | `npm run lint` and `npm test` |
| `claude` on PATH | Install [Claude Code](https://docs.anthropic.com/claude/docs) / Anthropic’s CLI; `claude --version` or equivalent |
| Claude authenticated | `claude login` (or current Anthropic flow) — subscription must be active |
| OpenClaw loads plugin | Point OpenClaw at this package or repo; **confirm against current OpenClaw docs** how `openclaw.plugin.json` / `main` are resolved |

## 2. OpenClaw integration sanity

1. Install or link the plugin the way your OpenClaw version expects (path vs npm).
2. Enable the plugin and merge config that matches **`src/plugin.ts`** (nested `engines`, `sessionTTLMs` in ms, `defaultFallbackChain` if desired).
3. Restart the OpenClaw host and confirm logs show something like:  
   `[sentinel-bridge] activated with 11 registered tools.`

## 3. Minimal Claude path (manual)

Execute via OpenClaw’s tool UI, agent, or debug console — **exact UI depends on OpenClaw**:

1. **`sb_engine_list`** — `claude` should show `available: true` / `healthy: true` if the binary is found.
2. **`sb_session_start`** — e.g. `{ "name": "live-test-1", "engine": "claude", "model": "sonnet" }`  
   - Expect `ok: true` and a `session` object with `status: "active"`.
3. **`sb_session_send`** — `{ "name": "live-test-1", "message": "Reply with exactly: LIVE_OK" }`  
   - Expect assistant text containing `LIVE_OK` (or visible failure from CLI).
4. **`sb_session_stop`** — `{ "name": "live-test-1" }`  
   - Session ends cleanly.

**Failure modes to note**

- CLI not found → engine descriptor `note` explains; fix PATH or `engines.claude.command`.
- Auth expired → CLI error in response; re-run login.
- Protocol mismatch after a CLI upgrade → may need updates in `src/engines/claude-engine.ts` (stream-json events).

## 4. Optional engines

| Engine | Extra checks |
|--------|----------------|
| **Codex** | `codex` on PATH, `OPENAI_API_KEY`; repeat steps 2–4 with `engine: "codex"`. |
| **Grok** | Set `engines.grok.enabled: true` and `apiKey` or `XAI_API_KEY`; repeat with `engine: "grok"`. |

## 5. Fallback chain (start only)

1. Temporarily break Claude (e.g. wrong `engines.claude.command`) while Codex works.
2. `sb_session_start` with `model: "opus"` (routes to Claude first) should **fail** Claude then **succeed** on Codex if `defaultFallbackChain` includes `codex`.
3. Restore Claude config after the test.

## 6. App / skill alignment

- [ ] Skill or app calls the **real** tool names from [API-REFERENCE.md](./API-REFERENCE.md) (not legacy names like `sb_session_compact`).
- [ ] Config keys match **`plugin.ts`** / [configuration.md](./configuration.md) (ms TTL, `engines.*`, `defaultFallbackChain`).
- [ ] You have one **documented** OpenClaw version + plugin version pair that you tested.

## 7. After verification

Record: date, OpenClaw version, `claude` CLI version, Node version, and pass/fail per section — helps the next merge or agent pick up without re-discovery.

See also [CONTEXT-HANDOFF.md](./CONTEXT-HANDOFF.md) for parallel branches and merge order.
