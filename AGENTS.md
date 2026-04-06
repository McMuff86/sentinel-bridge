# AGENTS.md — sentinel-bridge

## Project Overview

sentinel-bridge is an OpenClaw plugin that provides Claude Code CLI, Codex CLI, Grok API, and Ollama (local LLM) as engine providers. Clean-room implementation — no code copied from reference projects.

## Code Style

- **Language:** TypeScript (strict mode)
- **Module system:** ESM (`"type": "module"` in package.json)
- **Target:** Node.js 22+ (ES2022)
- **Formatting:** 2-space indent, single quotes, trailing commas, no semicolons omitted (always use them)
- **Line length:** 120 max
- **Imports:** Named imports, no `import *`. Group: node built-ins → external deps → internal.
- **Types:** Prefer interfaces over type aliases for object shapes. Use `type` for unions/intersections.
- **Enums:** Use string literal unions, not TypeScript enums.
- **Nullability:** Use `null` for intentional absence, `undefined` for optional/unset.
- **Error handling:** Throw `EngineError` (from `src/errors.ts`) with a typed `ErrorCategory` (`unavailable`, `auth_expired`, `rate_limited`, `timeout`, `context_overflow`, `transient`, `cancelled`, `unknown`). Set `retriable` appropriately. SessionManager and fallback chain use these categories for intelligent decisions.
- **Logging:** Use `StructuredLogger` (from `src/logging.ts`) via `this.log.info/warn/error(category, message, context)`. Categories: `session`, `engine`, `routing`, `fallback`, `rehydration`, `expiry`, `store`, `config`, `cleanup`. The logger integrates with OpenClaw's `api.logger` when available. No `console.log` in production code.

## File Structure

```
sentinel-bridge/
├── openclaw.plugin.json          # Plugin manifest (main → dist/index.js)
├── package.json
├── tsconfig.json
├── AGENTS.md
├── CHANGELOG.md
├── README.md
├── LICENSE
├── .github/workflows/ci.yml     # CI: test on push/PR to main
├── docs/
│   ├── TECHNICAL-ARCHITECTURE.md
│   ├── API-REFERENCE.md
│   ├── configuration.md
│   ├── getting-started.md
│   ├── LIVE-VERIFICATION.md
│   ├── CONTEXT-HANDOFF.md
│   └── INTEGRATION-NOTES-2026-04-05.md
├── src/
│   ├── index.ts                  # Plugin entry: activate(), tool registration, config merge
│   ├── types.ts                  # Shared types: IEngine, SessionInfo, EngineKind, etc.
│   ├── plugin.ts                 # Plugin metadata, EngineConfig type, DEFAULT_CONFIG
│   ├── session-manager.ts        # SessionManager orchestrator (mutex-protected)
│   ├── errors.ts                 # EngineError class with typed categories
│   ├── logging.ts                # StructuredLogger with JSON entries + categories
│   ├── tracking.ts               # UsageTracker: JSONL usage log, summaries
│   ├── engines/
│   │   ├── claude-engine.ts      # ClaudeEngine: CLI subprocess, stream-json
│   │   ├── codex-engine.ts       # CodexEngine: CLI per-message, auth detection
│   │   ├── grok-engine.ts        # GrokEngine: HTTP API, retry with backoff
│   │   ├── ollama-engine.ts      # OllamaEngine: local LLM, streaming SSE, retry
│   │   ├── create-engine.ts      # Engine factory
│   │   └── shared.ts             # mergeEngineConfig, token/cost math, utilities
│   ├── routing/
│   │   ├── model-aliases.ts      # Alias map (opus → claude-opus-4-6, etc.)
│   │   ├── resolve-model-route.ts # Model resolution: prefix, inference, aliases
│   │   ├── expand-fallback-chain.ts # Deduplicated fallback ordering
│   │   ├── routing-trace.ts      # Routing trace capture for observability
│   │   ├── select-engine.ts      # Capability-based primary engine selection
│   │   └── provider-capabilities.ts # Light capability registry
│   ├── sessions/
│   │   ├── session-store.ts      # JSON persistence (atomic writes)
│   │   ├── session-events.ts     # JSONL event timeline per session
│   │   ├── session-mutex.ts      # Per-session promise-based lock
│   │   ├── session-cleanup.ts    # TTL expiry sweep
│   │   ├── session-info.ts       # Session payload shaping, syncSession()
│   │   └── types.ts              # SessionRecord internal type
│   └── __tests__/
│       ├── session-manager.test.ts
│       ├── claude-engine.test.ts
│       ├── codex-engine.test.ts
│       ├── grok-engine.test.ts
│       ├── ollama-engine.test.ts
│       ├── errors.test.ts
│       ├── logging.test.ts
│       ├── session-mutex.test.ts
│       ├── session-store.test.ts
│       ├── session-events.test.ts
│       ├── session-name-validation.test.ts
│       ├── config-merge.test.ts
│       ├── tracking.test.ts
│       ├── index.test.ts
│       ├── plugin.test.ts
│       └── types.test.ts
└── dist/                         # Compiled output (gitignored)
```

## Testing Strategy

- **Framework:** vitest (run via `npx vitest run`)
- **Unit tests:** 122+ tests across 14 test files in `src/__tests__/`
- **Mocking:** Mock child_process.spawn for CLI engines, mock fetch for Grok/Ollama
- **Test naming:** `describe('ClassName')` → `it('should do X when Y')`
- **No integration tests in CI** — integration tests require actual CLI binaries and API keys, run manually
- **CI:** GitHub Actions runs tests on push/PR to main (Node 22)

### Running Tests

```bash
npx vitest run              # Run all unit tests
npx vitest run --reporter verbose  # Verbose output
```

## Branch Conventions

- `main` — stable, always passing
- `nightly/MM-DD-*` — night factory branches (auto-created)
- `feat/*` — feature branches
- `fix/*` — bugfix branches
- `docs/*` — documentation only

## Commit Conventions

Follow Conventional Commits:

```
type(scope): description

types: feat, fix, docs, test, refactor, chore, perf
scope: engine, session, plugin, types, docs (optional)
```

Examples:
```
feat(engine): implement ClaudeEngine with streaming JSON protocol
fix(session): handle TTL cleanup race condition
test(engine): add CodexEngine spawn mock tests
docs: update architecture diagram
```

## Development Rules

1. **Clean-room implementation.** Do not copy code from openclaw-claude-code or any reference project. Understand concepts, implement independently.
2. **Minimal dependencies.** Node.js built-ins first. Max 3 runtime dependencies.
3. **Lazy initialization.** Nothing heavy runs at plugin load time.
4. **Engine isolation.** Each engine is self-contained. No cross-engine imports.
5. **Type safety.** No `any` except in test mocks. Use `unknown` + type guards.
6. **Error context.** Every thrown error includes engine name, session name, and original error.
7. **Event logging.** Session lifecycle events are recorded via `SessionEventStore` (JSONL). Structured logs via `StructuredLogger`. No polling loops.
8. **Idempotent stops.** Calling `stop()` on an already-stopped session is a no-op.

## Dependencies

### Runtime
- None — zero runtime dependencies beyond Node.js built-ins (child_process, fs, path, crypto)

### Dev
- `typescript` ^5.8
- `vitest` ^3.x
- `@types/node` ^25
