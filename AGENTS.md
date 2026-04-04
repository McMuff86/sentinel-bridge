# AGENTS.md — sentinel-bridge

## Project Overview

sentinel-bridge is an OpenClaw plugin that provides Claude Code CLI, Codex CLI, and Grok API as engine providers. Clean-room implementation — no code copied from reference projects.

## Code Style

- **Language:** TypeScript (strict mode)
- **Module system:** ESM (`"type": "module"` in package.json)
- **Target:** Node.js 22+ (ES2024)
- **Formatting:** 2-space indent, single quotes, trailing commas, no semicolons omitted (always use them)
- **Line length:** 120 max
- **Imports:** Named imports, no `import *`. Group: node built-ins → external deps → internal.
- **Types:** Prefer interfaces over type aliases for object shapes. Use `type` for unions/intersections.
- **Enums:** Use string literal unions, not TypeScript enums.
- **Nullability:** Use `null` for intentional absence, `undefined` for optional/unset.
- **Error handling:** Always catch and wrap errors with context. Never swallow errors silently.
- **Logging:** Use the plugin API logger (`api.logger.info/warn/error`). No `console.log` in production code.

## File Structure

```
sentinel-bridge/
├── openclaw.plugin.json      # Plugin manifest
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── PRD.md
├── AGENTS.md
├── README.md
├── LICENSE
├── docs/
│   ├── TECHNICAL-ARCHITECTURE.md
│   ├── API-REFERENCE.md
│   └── CONTEXT-HANDOFF.md   # onboarding + parallel-branch notes for agents
├── src/
│   ├── index.ts              # Plugin entry point (register tools + services)
│   ├── types.ts              # Shared types, interfaces, pricing
│   ├── session-manager.ts    # SessionManager orchestrator
│   ├── validation.ts         # Input validation utilities
│   ├── engines/
│   │   ├── base.ts           # AbstractEngine (shared IEngine logic)
│   │   ├── claude.ts         # ClaudeEngine implementation
│   │   ├── codex.ts          # CodexEngine implementation
│   │   └── grok.ts           # GrokEngine implementation
│   └── __tests__/
│       ├── session-manager.test.ts   # routing + start fallback (mocked engines)
│       ├── claude-engine.test.ts
│       ├── codex-engine.test.ts
│       ├── grok-engine.test.ts
│       ├── types.test.ts
│       └── validation.test.ts
└── dist/                     # Compiled output (gitignored)
```

## Testing Strategy

- **Framework:** vitest
- **Unit tests:** Every module in `src/` has a corresponding test in `src/__tests__/`
- **Mocking:** Mock child_process.spawn for CLI engines, mock fetch/http for Grok
- **Coverage target:** >80% lines
- **Test naming:** `describe('ClassName')` → `it('should do X when Y')`
- **No integration tests in CI** — integration tests require actual CLI binaries and API keys, run manually

### Running Tests

```bash
npm test          # Run all unit tests
npm run test:cov  # With coverage report
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
7. **Event-driven.** Engines emit events; SessionManager listens. No polling loops.
8. **Idempotent stops.** Calling `stop()` on an already-stopped session is a no-op.

## Dependencies (Planned)

### Runtime
- None beyond Node.js built-ins (child_process, events, fs, path, http/https)

### Dev
- `typescript` ^5.7
- `vitest` ^3.x
- `@types/node` ^22
- `eslint` + `@typescript-eslint/*`
