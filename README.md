# sentinel-bridge

**Multi-engine LLM orchestration layer — a portfolio project exploring how to route prompts across Claude, Codex, Grok, and Ollama through a single, type-safe interface.**

> **Status: Archived.** This project was built as a learning exercise and is no longer actively developed. The code is functional and well-tested but not intended for production use.

---

## What This Is

sentinel-bridge unifies four LLM engines behind one abstraction:

| Engine | Transport | How it works |
|--------|-----------|-------------|
| **Claude** | CLI subprocess | Spawns `claude` CLI, parses stream-json output |
| **Codex** | CLI subprocess | Spawns `codex` CLI in quiet mode, captures agent messages |
| **Grok** | HTTP API | OpenAI-compatible endpoint, requires `XAI_API_KEY` |
| **Ollama** | Local HTTP | Talks to localhost Ollama instance with SSE streaming |

On top of that, it provides:

- **34 MCP tools** for controlling everything from any MCP-compatible client
- **Adaptive routing** via Thompson Sampling (Bayesian), EMA, or blended strategies
- **DAG workflow engine** with dependency resolution and step-level loops
- **Session persistence** with atomic writes and crash recovery
- **Circuit breaker** and health checks per engine
- **Multi-agent roles** with shared context (blackboard pattern)
- **Zero runtime dependencies** — only Node.js 22+ built-ins

## What I Learned Building This

This project taught me more than any tutorial could:

- **Bayesian decision-making**: Implementing Thompson Sampling from scratch — Beta distributions, Gamma sampling via Marsaglia-Tsang, exploration vs. exploitation tradeoffs
- **Subprocess orchestration**: The pain of parsing unstructured CLI output, graceful process termination (SIGTERM → SIGKILL), and why SDKs exist
- **Crash-safe persistence**: Atomic writes (write to .tmp, rename), JSONL append-only event logs, mutex-locked concurrent access
- **When abstraction leaks**: CLI engines and HTTP engines are fundamentally different beasts. Unifying them under one interface is possible but the differences always surface
- **When to stop**: The orchestration layer (workflows, roles, routing) solves real engineering problems — but problems that almost nobody has in this context. Knowing when a project has served its purpose is a skill too

## Tech Stack

- **TypeScript** (strict mode)
- **Node.js 22+** (no polyfills)
- **Vitest** — 463 tests across 31 test files
- **MCP Protocol** — JSON-RPC 2.0 over stdio
- **Zero runtime dependencies**

## Architecture

```
MCP Tools (34)  →  SessionManager (mutex-locked)
                      ├── Engine Adapters (4 built-in + plugin system)
                      ├── Adaptive Router (Thompson / EMA / Blended / Static)
                      ├── Workflow Engine (DAG with dependency resolution)
                      ├── Circuit Breaker + Health Checks
                      ├── Role Registry + Context Blackboard
                      └── Session Persistence (JSON + JSONL events)
```

## Running It

```bash
npm install
npm run build
npm test          # 463 tests

# As MCP server
node dist/mcp/index.js

# As library
import { SessionManager } from 'sentinel-bridge';
const manager = new SessionManager({ defaultEngine: 'claude' });
```

## Numbers

- **~7,300 lines** of TypeScript source
- **~4,500 lines** of tests
- **463 tests**, all passing
- **34 MCP tools**
- **4 engine adapters**
- **0 runtime dependencies**

## License

[MIT](LICENSE) © 2026 Adrian Muff
