# Context Handoff — sentinel-bridge v0.2.0

> Last updated: 2026-04-07
> For code style and rules see [AGENTS.md](../AGENTS.md), architecture details in [TECHNICAL-ARCHITECTURE.md](./TECHNICAL-ARCHITECTURE.md).

## What happened in this session

Executed Phase 0 + Phase 1 of a 10-phase plan to make sentinel-bridge a standalone npm-publishable MCP tool with ML-based adaptive routing and autoresearch workflows.

### Changes made (uncommitted on sentinel-bridge main)

| File | Change |
|------|--------|
| `src/tracking.ts:598-604` | **Bug fix**: Added `'ollama'` to `requireEngineKind()` guard — previously any Ollama usage log entry threw |
| `src/__tests__/tracking.test.ts` | Added test for Ollama engine summary (log + query pipeline) |
| `src/state-dir.ts` | **New file**: `getStateDir()` utility — resolves `SENTINEL_BRIDGE_STATE_DIR` env var or defaults to `~/.sentinel-bridge/state` |
| `src/orchestration/context-store.ts` | Refactored to use `getStateDir()` instead of hardcoded `.openclaw/` path |
| `src/orchestration/context-events.ts` | Same refactor |
| `src/orchestration/workflow-store.ts` | Same refactor |
| `src/orchestration/role-store.ts` | Same refactor |
| `src/sessions/session-store.ts` | Same refactor |
| `src/sessions/session-events.ts` | Same refactor |
| `src/index.ts` | Added public exports: `TaskCategory`, `TaskClassification`, `classifyTask`, `ContextStore`, `ContextEntry`, `QueueSnapshot`, `getStateDir` |
| `package.json` | v0.2.0, expanded exports map (`.`, `./mcp`, `./types`), keywords, license, repository |
| `src/plugin.ts` | Version bump 0.1.0 → 0.2.0 |
| `openclaw.plugin.json` | Version bump |
| `src/mcp/index.ts` | Version bump |

**Build**: Clean. **Tests**: 391/391 passed. **npm pack**: 116kB, no test files included.

### Changes made on mission-control

| Action | Details |
|--------|---------|
| Merged `origin/sentinel-bridge-branch` into `main` | Commit `4e76c40`. Brought engine toggle endpoint, `buildEngineInfo()`, config persistence. No conflicts. |
| `src/lib/sentinel-api.ts` | Added `toggleEngine(engine, enabled)` function |
| `src/stores/bridgeStore.ts` | Added `toggleEngine` action (calls API + triggers refresh) |

Mission-control main is 2 commits ahead of origin/main (not pushed).

**Pre-existing build errors** (not introduced by us): Planning components + ExportControls have TS errors from Milestone 4.

## Full implementation plan

The complete plan lives at: `~/.claude/plans/groovy-dancing-biscuit.md`

### Phase overview

```
Phase 0  [DONE]  Housekeeping (tracking bug, MC branch merge, toggleEngine)
Phase 1  [DONE]  npm publish prep (state-dir, package.json, exports, version bump)
Phase 2  [NEXT]  Engine Plugin System (engine-contract.ts, engine-registry.ts)
Phase 3  [NEXT]  Outcome Signal (UsageLogEntry + outcome/quality fields, UsageTracker in SessionManager)
Phase 4          Thompson Sampling (adaptive-router.ts, Beta distributions per engine:category)
Phase 5          EMA Scoring (exponential moving average strategy in AdaptiveRouter)
Phase 6  [NEXT]  Loop Workflows (workflow-types.ts mode:'loop', loop evaluator, cyclic DAG)
Phase 7          Autoresearch Template (researcher/analyst roles, createAutoresearchWorkflow)
Phase 8          Embedding KNN Routing (Ollama nomic-embed-text, cosine similarity, KNN vote)
Phase 9          Mission-Control Integration (routing UI, autoresearch panel, new endpoints)
Phase 10         Polish + Publish (README, CHANGELOG, CI/CD, npm publish)
```

### Dependency graph — what can run in parallel

```
Phase 2 (Engine Plugin)     — no deps, start anytime
Phase 3 (Outcome Signal)    — no deps, start anytime
Phase 6 (Loop Workflows)    — no deps, start anytime
Phase 4 (Thompson)          — needs Phase 3
Phase 5 (EMA)               — needs Phase 4
Phase 7 (Autoresearch)      — needs Phase 6
Phase 8 (KNN)               — needs Phase 5
Phase 9 (MC Integration)    — needs Phases 2, 5, 7
Phase 10 (Publish)          — needs all
```

**Recommended next: Start Phase 2, 3, and 6 in parallel.**

## Phase 2: Engine Plugin System (details)

### What to build

1. **`src/engines/engine-contract.ts`** (new) — `IEngineFactory` interface:
   ```typescript
   interface IEngineFactory {
     readonly engineKind: string;
     readonly displayName: string;
     readonly transport: 'subprocess' | 'http';
     readonly privacyLevel: 'cloud' | 'local';
     create(config: EngineConfig): IEngine;
     healthCheck?(config: Partial<EngineConfig>): Promise<boolean>;
   }
   ```

2. **`src/engines/engine-registry.ts`** (new) — Registry class:
   - `register(factory)`, `create(kind, config)`, `has(kind)`, `list()`
   - 4 built-in factories registered in constructor
   - `src/engines/create-engine.ts` becomes thin wrapper

3. **`src/types.ts`** — Add `BuiltInEngineKind` alias, keep `EngineKind` unchanged (non-breaking)

4. **`src/session-manager.ts`** — Add `registerEngine(factory)` method

5. **`src/index.ts`** — Export `IEngineFactory`, `EngineRegistry`

6. **`src/__tests__/engine-registry.test.ts`** (new) — Tests

## Phase 3: Outcome Signal (details)

### What to build

1. **`src/tracking.ts`** — Add optional fields to `UsageLogEntry`/`UsageLogInput`:
   - `outcome?: 'success' | 'failure' | 'partial'`
   - `qualityScore?: number` (0-1)
   - `taskCategory?: string`
   - Update `normalizeUsageLogEntry()` and `parseStoredUsageLogEntry()`
   - Add `getOutcomesByEngineAndCategory()` query method

2. **`src/session-manager.ts`** — Wire `UsageTracker`:
   - Add `readonly tracker: UsageTracker` (currently NOT present!)
   - After `sendMessage`: log with `outcome: 'success'`, `taskCategory: classifyTask(message).primary`
   - On error: log with `outcome: 'failure'`

3. Tests in `src/__tests__/tracking.test.ts`

## Phase 6: Loop Workflows (details)

### What to build

1. **`src/orchestration/workflow-types.ts`** — Add optional fields (backwards-compat):
   - `WorkflowStepDefinition.loop?: { maxIterations: number; continueCondition?: string; convergenceKey?: string; convergenceThreshold?: number }`
   - `WorkflowStepDefinition.condition?: string`
   - `WorkflowDefinition.mode?: 'dag' | 'loop'`
   - `WorkflowStepState.iteration?: number`

2. **`src/orchestration/workflow-engine.ts`**:
   - `validateWorkflow`: if `mode === 'loop'`, allow cycles but require LoopConfig with maxIterations on at least one step per cycle
   - `executeStep`: after completion, check `loop.continueCondition` → if continue + under maxIterations, reset step + downstream to 'pending', increment iteration

3. **`src/orchestration/loop-evaluator.ts`** (new):
   - `evaluateLoopCondition(config, output, context, workspace): boolean`
   - String-based: `output.includes(continueCondition)`
   - Convergence-based: delta from blackboard values

4. Tests in `src/__tests__/workflow-loop.test.ts` (new)

## Key architecture decisions made

- **State directory**: `~/.sentinel-bridge/state` (was `~/.openclaw/extensions/sentinel-bridge/state`). Override with `SENTINEL_BRIDGE_STATE_DIR` env var.
- **EngineKind type stays narrow** (`'claude' | 'codex' | 'grok' | 'ollama'`). Engine registry accepts `string` internally. Non-breaking.
- **Thompson Sampling**: Will use Joehnk algorithm for Beta sampling (zero dependencies, just `Math.random` + `Math.pow`).
- **Loop mode**: Opt-in via `mode: 'loop'` on WorkflowDefinition. Default `'dag'` preserves existing cycle rejection.
- **Autoresearch**: Will be a workflow template (`createAutoresearchWorkflow`) using loop mode + new roles (researcher, analyst).

## Key files reference

| Component | File | Notes |
|-----------|------|-------|
| State dir utility | `src/state-dir.ts` | New, central path resolution |
| Session manager | `src/session-manager.ts` | Central orchestrator, will gain UsageTracker + AdaptiveRouter |
| Workflow engine | `src/orchestration/workflow-engine.ts` | DAG executor, will gain loop support |
| Workflow types | `src/orchestration/workflow-types.ts` | Step/State definitions, will gain loop fields |
| Task router | `src/orchestration/task-router.ts` | Static ENGINE_STRENGTHS, will gain adaptive router |
| Task classifier | `src/orchestration/task-classifier.ts` | Heuristic keyword/pattern, 7 categories |
| Tracking | `src/tracking.ts` | JSONL usage log, will gain outcome fields |
| Engine factory | `src/engines/create-engine.ts` | Will become thin wrapper over registry |
| MCP tools | `src/mcp/tools.ts` | 33 tools, will gain sb_routing_stats, sb_routing_config |
| Plugin config | `src/plugin.ts` | DEFAULT_CONFIG, PLUGIN_META |
| Public exports | `src/index.ts` | ~1100 lines, tool handlers + exports |

## Conventions

- English in code, TypeScript strict, ESM, single quotes, semicolons
- `EngineError` with typed categories (not plain Error)
- `StructuredLogger` for logging (`this.log.info(category, message, context)`)
- Atomic JSON writes (write to temp, rename) for all stores
- Tests with vitest, mock engines in session-manager tests
- Zero runtime dependencies (only Node.js built-ins)
