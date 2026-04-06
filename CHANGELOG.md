# Changelog

All notable changes to sentinel-bridge are documented here.

## [Unreleased]

### Added
- **Error categorization** — `EngineError` class with typed categories
  (`unavailable`, `auth_expired`, `rate_limited`, `timeout`, `context_overflow`,
  `transient`, `cancelled`). Fallback chain and retry logic can now make
  intelligent decisions.
- **Grok retry with exponential backoff** — retriable errors (429, 5xx, timeout)
  are retried up to 3 times with exponential backoff, respecting `Retry-After`.
- **Session cancel** — `sb_session_cancel` tool aborts the current in-flight
  operation without destroying the session.
- **CI** — GitHub Actions workflow: test on push/PR to main (Node 22).
- **CHANGELOG** — this file.

### Changed
- All three engines (Claude, Codex, Grok) now throw `EngineError` with
  proper categories instead of plain `Error`.
- `IEngine` interface gains a `cancel()` method.

## [0.1.0] — 2026-04-06

### Added
- **Session-level mutex** — per-session promise-based lock serialises
  send/stop/compact to prevent race conditions.
- **Structured logging** — `StructuredLogger` with JSON entries, categories,
  and OpenClaw `api.logger` integration.
- **Atomic store writes** — write-to-temp + rename prevents data loss on crash.
- **Session name validation** — strict regex at all public API entry points
  prevents path traversal.
- **Config deep merge** — engine `env` is deep-merged so user overrides don't
  wipe defaults.
- **Expired session store cleanup** — persisted sessions that expired offline
  are purged on next sweep.
- **Event store hardening** — malformed JSONL lines skipped, auto-pruning at
  1000 events per session.
- **Rehydration deduplication** — prevents concurrent rehydration of the same
  session.

### Core (initial release)
- Three engine adapters: Claude Code CLI, Codex CLI, Grok HTTP API.
- Unified `sb_*` tool namespace (13 tools).
- Session lifecycle: start, send, stop, compact, list, status, overview.
- Routing: model aliases, `engine/model` syntax, capability-based primary
  selection, configurable fallback chain.
- Per-turn and cumulative usage/cost tracking.
- Session persistence across tool calls (`sessions.json`).
- JSONL event timeline per session.
- CLI backend registration for OpenClaw.
- Zero runtime dependencies (Node.js 22+).
