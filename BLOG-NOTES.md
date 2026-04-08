# Blog Post Notes: "What I Learned Building a Multi-Engine LLM Orchestrator"

These are raw notes for a blog post. Not the post itself.

---

## The Hook

I built a 7,300-line TypeScript library that routes prompts across Claude, Codex, Grok, and Ollama — with Bayesian adaptive routing, DAG workflows, and 34 MCP tools. Then I archived it. Here's why that was the right call, and what I'd do differently.

---

## Part 1: What I Built (keep short — max 20% of the post)

- sentinel-bridge: multi-engine LLM orchestration layer
- 4 engines unified behind one interface (2 CLI-based, 2 HTTP-based)
- Adaptive routing using Thompson Sampling (Bayesian exploration/exploitation)
- DAG workflow engine with dependency resolution
- 34 MCP tools so any MCP-compatible agent can use it
- Zero runtime dependencies, 463 tests
- Built in ~2 weeks, solo

**Key point:** Don't just list features. Show the architecture diagram. Explain *why* these features — what problem was each solving?

---

## Part 2: The Interesting Technical Bits (this is the meat — 50% of the post)

### Thompson Sampling From Scratch

- Implemented Bayesian multi-armed bandit for engine selection
- Beta distribution sampling without any math library
- Marsaglia-Tsang Gamma variate generation
- Box-Muller transform for normal distributions
- The exploration/exploitation tradeoff: why you don't just always pick the "best" engine
- **The catch:** LLM responses don't have a natural success/failure signal. HTTP requests have status codes. LLM answers have... vibes. Without automatic outcome signals, the whole Bayesian apparatus collapses back to static routing.
- **Lesson:** Fancy algorithms need matching data pipelines. If you can't close the feedback loop, don't open it.

### CLI Subprocesses as Engine Adapters

- Spawning `claude` and `codex` as child processes, parsing their stdout
- Why this is both genius and terrible:
  - Genius: zero SDK dependency, works with any CLI version, captures full output
  - Terrible: no API contract on stdout format, any CLI update can break parsing, startup latency per session, no real streaming guarantee
- Graceful process termination: SIGTERM with timeout, escalate to SIGKILL
- **Lesson:** SDKs exist for a reason. Wrapping CLIs is great for prototyping but fragile for production.

### Crash-Safe Persistence Without a Database

- Atomic writes: write JSON to .tmp file, then rename (rename is atomic on Linux/Mac)
- JSONL append-only event logs per session (cheap audit trail)
- Crash recovery: if main file is corrupt, check .tmp file
- Per-session mutex (promise-based lock) to prevent race conditions
- **Lesson:** You don't need SQLite for persistent state. Atomic rename + JSONL gets you 90% of the way for single-process apps.

### The Abstraction That Leaked

- Tried to unify CLI engines (subprocess, parse stdout) and HTTP engines (fetch, parse JSON) behind one `IEngine` interface
- On paper: `start() → send(msg) → stop()` — clean and simple
- In practice: CLI engines have process lifecycle, startup time, signal handling. HTTP engines are stateless per-request. Error models are completely different.
- The interface works but the differences leak through: different timeout behaviors, different streaming semantics, different error categories that matter
- **Lesson:** Abstractions work best when the things you're abstracting are actually similar. "Send text, get text back" sounds the same, but the operational characteristics are worlds apart.

### Zero Dependencies as Constraint

- Forced me to implement HTTP client, JSON-RPC server, Beta sampling, mutex — all from scratch
- Good: tiny deployment footprint, no supply-chain risk, deep understanding of every line
- Bad: reinventing wheels that have been round for a decade
- **Lesson:** Zero deps is a great learning constraint but a bad product strategy. For portfolio projects, it shows depth. For real products, use the damn library.

---

## Part 3: Why I Archived It (the honest part — 30% of the post)

### The Target Audience Problem

- Who needs to dynamically route between 4 LLM engines?
- Most developers: pick a model, use it, maybe switch manually if it's bad
- The people who DO need multi-engine routing work at companies with dedicated ML platform teams — they're not installing npm packages, they're building internal systems
- **I built a solution and then went looking for a problem.** Should have been the other way around.

### The Competition Problem

- LangChain, LlamaIndex, AutoGen, CrewAI, Semantic Kernel — all do multi-model orchestration
- They have teams, funding, communities, documentation, integrations
- "Zero deps, 7K lines" is not a differentiator that attracts users
- **Lesson:** Building something technically superior doesn't matter if the ecosystem is already established.

### The Over-Engineering Problem

- Circuit breaker: designed for 1000+ req/min microservices. For LLM interactions (maybe 10/hour)? Overkill.
- Health checks with latency tracking: useful in distributed systems. For a single-process library? `ollama list` would do.
- 6 built-in agent roles with system prompts: any user can write `{role: "system", content: "You are an architect"}` in 1 line
- Routing traces, context events, cost tracking: observability is great when someone is observing. Nobody was observing.
- **Lesson:** Production patterns applied to hobby-scale projects don't make the project production-grade. They make it over-engineered.

### The MCP Bet

- Built 34 MCP tools, betting on the MCP ecosystem growing
- MCP is still early. The spec changes. Clients handle tools differently.
- Claude Code is adding multi-model features natively, reducing the need for external orchestration
- **Lesson:** Building on emerging standards is a gamble. Sometimes you're early. Sometimes you're just wrong.

### When to Stop

- The project was "done" after week 1 (4 engines, basic sessions, MCP tools)
- Week 2 was all orchestration: workflows, routing, roles, circuit breakers
- Each feature was well-built but the marginal value was decreasing rapidly
- **The hardest skill in engineering isn't building — it's stopping.**

---

## Part 4: What I'd Do Differently

1. **Start with the user, not the architecture.** I designed a beautiful system and then asked "who wants this?" Flip that.
2. **Prototype ugly, validate, then build clean.** The first version should have been 200 lines of hacky glue code to test if anyone cared.
3. **Pick one feature, not all features.** Either build the best adaptive router OR the best MCP engine server OR the best workflow engine. Not all three.
4. **Use the constraint earlier.** "Zero dependencies" was fun but cost me time I could have spent on user research.
5. **Write the blog post first.** If you can't write a compelling "why" before building, the project doesn't have one.

---

## Possible Titles

- "I Built a 7,300-Line LLM Orchestrator and Then Archived It"
- "What I Learned Building (and Killing) a Multi-Engine LLM Router"
- "Thompson Sampling, DAG Workflows, and Knowing When to Stop"
- "The Over-Engineering Diaries: A Multi-Engine LLM Orchestrator"

---

## Key Takeaways (for the closing)

1. **The best technical learning comes from projects you don't ship.** You can't learn Bayesian routing from a tutorial the way you learn it from implementing Marsaglia-Tsang at 2am.
2. **Over-engineering teaches you where the line is.** You only learn "this is overkill" by crossing the line.
3. **Archiving isn't failure.** The code exists, the tests pass, the knowledge transferred. That's the whole point.
4. **Build the next thing.** The only real failure is staying on a project that's taught you everything it can.

---

## Assets to Include

- Architecture diagram (from README)
- Code snippet: Thompson Sampling implementation (~30 lines, the Gamma/Beta sampling)
- Code snippet: Atomic write pattern (write .tmp → rename)
- Screenshot: all 463 tests passing
- GitHub repo link

---

## Tone

Honest but not self-deprecating. The project was good engineering — the mistake was scope and direction, not execution. Write for developers who've been in the same trap: building something cool that nobody asked for.
