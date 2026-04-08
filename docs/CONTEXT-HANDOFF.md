# Context Handoff — sentinel-bridge v0.2.0

> Last updated: 2026-04-08
> For code style and rules see [AGENTS.md](../AGENTS.md), architecture details in [TECHNICAL-ARCHITECTURE.md](./TECHNICAL-ARCHITECTURE.md).

## What happened in this session

Executed Phases 2-10 of the 10-phase implementation plan. All phases are now complete.

### sentinel-bridge commits (on main, pushed)

| Commit | Description |
|--------|-------------|
| `f7a4737` | Phases 2-7: engine plugins, adaptive routing (Thompson+EMA), outcome tracking, loop workflows, autoresearch template |
| `3935ee5` | Phase 8+10: KNN embedding routing, embedding store, CHANGELOG update |

### mission-control commit (on main, pushed)

| Commit | Description |
|--------|-------------|
| `6ac8039` | Phase 9: routing/autoresearch endpoints, RoutingWidget, AutoresearchPanel |

### Build & Test Status

- **Build**: Clean (`tsc -p tsconfig.json`, zero errors)
- **Tests**: 480/480 passed across 33 test files
- **npm pack**: 136kB, 160 files
- **MCP tools**: 35

## Full implementation plan

The complete plan lives at: `~/.claude/plans/groovy-dancing-biscuit.md`

### Phase overview

```
Phase 0   [DONE]  Housekeeping (tracking bug, MC branch merge, toggleEngine)
Phase 1   [DONE]  npm publish prep (state-dir, package.json, exports, version bump)
Phase 2   [DONE]  Engine Plugin System (IEngineFactory, EngineRegistry)
Phase 3   [DONE]  Outcome Signal (outcome/qualityScore/taskCategory on UsageLogEntry)
Phase 4   [DONE]  Thompson Sampling (AdaptiveRouter, Beta distributions, routing-stats-store)
Phase 5   [DONE]  EMA Scoring (EMA + blended strategies, sb_routing_config)
Phase 6   [DONE]  Loop Workflows (LoopConfig, loop-evaluator, cyclic DAG support)
Phase 7   [DONE]  Autoresearch Template (researcher/analyst roles, createAutoresearchWorkflow)
Phase 8   [DONE]  Embedding KNN Routing (embedding-client, knn-router, embedding-store, ensemble)
Phase 9   [DONE]  Mission-Control Integration (routing UI, autoresearch panel, new endpoints)
Phase 10  [DONE]  Polish + Publish (CHANGELOG, npm pack verified)
```

## What remains / potential next steps

All 10 phases are complete. Potential follow-up work:

1. **npm publish** — `npm publish` to registry (package is ready, `npm pack` verified at 136kB)
2. **CI/CD** — `.github/workflows/ci.yml` for lint, test, build, publish-on-tag
3. **README overhaul** — Broader audience README with Quick Start for Claude Code / Cursor / Windsurf
4. **Coverage** — `npx vitest run --coverage` to verify >80% on new files
5. **Mission-Control pre-existing TS errors** — Planning components + ExportControls have TS errors from Milestone 4 (not introduced by us)
6. **Wire RoutingWidget + AutoresearchPanel into BridgeView** — Components are created but not yet imported/rendered in the main view

## New files created in this session

### sentinel-bridge

| File | Purpose |
|------|---------|
| `src/engines/engine-contract.ts` | `IEngineFactory` interface |
| `src/engines/engine-registry.ts` | `EngineRegistry` class with 4 built-in factories |
| `src/orchestration/adaptive-router.ts` | Thompson Sampling + EMA + blended + KNN + ensemble strategies |
| `src/orchestration/routing-stats-store.ts` | JSON persistence for routing Beta params |
| `src/orchestration/loop-evaluator.ts` | `evaluateLoopCondition()` — string match + convergence |
| `src/orchestration/embedding-client.ts` | Ollama nomic-embed-text client + `cosineSimilarity()` |
| `src/orchestration/knn-router.ts` | KNN router with embedding records, K-nearest vote |
| `src/orchestration/embedding-store.ts` | JSONL persistence for embedding records (10k cap) |
| `src/__tests__/engine-registry.test.ts` | 11 tests |
| `src/__tests__/adaptive-router.test.ts` | 28 tests |
| `src/__tests__/workflow-loop.test.ts` | 17 tests |
| `src/__tests__/knn-router.test.ts` | 15 tests |

### mission-control

| File | Purpose |
|------|---------|
| `src/components/dashboard/RoutingWidget.tsx` | Strategy selector + per-engine success rate bars |
| `src/components/AutoresearchPanel.tsx` | Research objective input, workflow status monitor |

## Modified files in this session

### sentinel-bridge

| File | Changes |
|------|---------|
| `src/engines/create-engine.ts` | Refactored to thin wrapper over `EngineRegistry` |
| `src/types.ts` | Added `BuiltInEngineKind` alias |
| `src/tracking.ts` | Outcome fields (outcome, qualityScore, taskCategory), `OutcomeSummary`, `getOutcomesByEngineAndCategory()` |
| `src/orchestration/workflow-types.ts` | `LoopConfig`, `mode: 'dag'|'loop'`, `iteration` on step state |
| `src/orchestration/workflow-engine.ts` | Loop-aware validation + loop execution with step/downstream reset |
| `src/orchestration/workflow-templates.ts` | `createAutoresearchWorkflow()`, `AutoresearchConfig` |
| `src/orchestration/roles.ts` | Added `researcher` and `analyst` built-in roles (now 6 total) |
| `src/orchestration/task-router.ts` | `method: 'thompson'|'static'` field, optional `adaptiveRouter` param |
| `src/session-manager.ts` | `EngineRegistry`, `AdaptiveRouter`, `RoutingStatsStore`, outcome recording, `persistRoutingStats()`, `registerEngine()`, routing strategy get/set |
| `src/index.ts` | All new type/value exports, `sb_routing_stats` + `sb_routing_config` tool defs, autoresearch in `sb_workflow_template` |
| `src/mcp/tools.ts` | `sb_routing_stats`, `sb_routing_config` MCP tools, autoresearch in template tool |
| `CHANGELOG.md` | Comprehensive entries for Phases 2-9 |
| `src/__tests__/tracking.test.ts` | +7 outcome signal tests |
| `src/__tests__/workflow-templates.test.ts` | +6 autoresearch tests |
| `src/__tests__/index.test.ts` | Updated tool count (35) and names |

### mission-control

| File | Changes |
|------|---------|
| `routes/sentinel.js` | +5 endpoints: routing stats/config, autoresearch start/status |
| `src/lib/sentinel-api.ts` | `RoutingStat`, routing + autoresearch API functions |
| `src/stores/bridgeStore.ts` | `routingStrategy`, `routingStats`, `refreshRouting()`, `setRoutingStrategy()` |

## Key architecture decisions

- **State directory**: `~/.sentinel-bridge/state` (override: `SENTINEL_BRIDGE_STATE_DIR`)
- **EngineKind type stays narrow** (`'claude'|'codex'|'grok'|'ollama'`). Registry accepts `string` internally.
- **Thompson Sampling**: Marsaglia-Tsang Gamma + Box-Muller normal (zero deps)
- **EMA alpha**: 0.3 (configurable), blended: 70% EMA + 30% Thompson
- **KNN**: Ollama nomic-embed-text, cosine similarity, ensemble: 0.3T + 0.4E + 0.3K
- **Loop mode**: Opt-in via `mode: 'loop'`. Default `'dag'` preserves cycle rejection.
- **selectEngine is sync, selectEngineAsync for KNN/ensemble** — avoids breaking existing callers
- **Autoresearch**: DAG pipeline with loop on analyze step (no cycle needed — loop resets analyze + downstream)
- **6 routing strategies**: thompson, ema, blended, knn, ensemble, static

## Key files reference

| Component | File | Notes |
|-----------|------|-------|
| Engine contract | `src/engines/engine-contract.ts` | `IEngineFactory` interface |
| Engine registry | `src/engines/engine-registry.ts` | 4 built-in, extensible via `register()` |
| Adaptive router | `src/orchestration/adaptive-router.ts` | 6 strategies, Beta sampling, EMA, KNN |
| KNN router | `src/orchestration/knn-router.ts` | Embedding-based K-nearest routing |
| Embedding client | `src/orchestration/embedding-client.ts` | Ollama nomic-embed-text + cosine sim |
| Loop evaluator | `src/orchestration/loop-evaluator.ts` | String match + convergence strategies |
| Workflow types | `src/orchestration/workflow-types.ts` | LoopConfig, mode, iteration |
| Workflow engine | `src/orchestration/workflow-engine.ts` | DAG + loop execution |
| Workflow templates | `src/orchestration/workflow-templates.ts` | Pipeline, fan-out, autoresearch |
| Roles | `src/orchestration/roles.ts` | 6 built-in roles |
| Task router | `src/orchestration/task-router.ts` | Static + adaptive routing |
| Tracking | `src/tracking.ts` | JSONL usage log with outcome fields |
| Session manager | `src/session-manager.ts` | Central orchestrator |
| Public exports | `src/index.ts` | ~1200 lines, tool handlers + exports |
| MCP tools | `src/mcp/tools.ts` | 35 tools |
| Routing widget | `mission-control/.../RoutingWidget.tsx` | Dashboard component |
| Autoresearch panel | `mission-control/.../AutoresearchPanel.tsx` | Research UI |

## Conventions

- English in code, TypeScript strict, ESM, single quotes, semicolons
- `EngineError` with typed categories (not plain Error)
- `StructuredLogger` for logging (`this.log.info(category, message, context)`)
- Atomic JSON writes (write to temp, rename) for all stores
- Tests with vitest, mock engines in session-manager tests
- Zero runtime dependencies (only Node.js built-ins)
