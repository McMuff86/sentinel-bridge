# Integration notes — 2026-04-05

Short record of what was verified on the live host during the first real `sentinel-bridge` integration pass.

## Environment

- Node: `v22.22.0`
- Claude Code: `2.1.92`
- Codex CLI: `0.117.0`
- Repo: `sentinel-bridge`

## Verified paths

### Claude
- `claude` present on PATH
- live `SessionManager` start/send/stop path verified
- output contained `LIVE_OK`
- routing trace returned expected selected route

### Codex
- `codex` present on PATH
- ChatGPT login present
- live `SessionManager` start/send/stop path verified
- output contained `LIVE_OK`
- routing trace returned expected selected route

## Real integration findings

1. Claude `--output-format stream-json` required `--verbose` on this host/CLI version.
2. `sonnet` alias needed to resolve to `claude-sonnet-4-5` instead of `claude-sonnet-4`.
3. Codex subscription detection needed to use `codex login status`.
4. In Codex subscription mode, inherited `OPENAI_API_KEY` / `CODEX_API_KEY` must not leak into the process env, otherwise the run can drift onto API-key billing / quota behavior.
5. In Codex API-key mode, config-provided key should override ambient process env.

## Why this matters

These were not theoretical cleanups — they were found by running the real CLIs through the real `SessionManager`.

This file exists so future integration work with the engine layer / OpenClaw runtime starts from facts, not guesses.
