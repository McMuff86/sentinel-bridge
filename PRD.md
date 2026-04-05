# PRD — sentinel-bridge

## Problem Statement

OpenClaw increasingly spans multiple providers, auth modes, and runtime styles. The missing piece is a thin layer that can route work across heterogeneous engines without leaking provider-specific quirks into higher-level orchestration.

The hard problem is not just “call model X.” It is:

- choosing the right engine,
- preserving session continuity,
- failing over cleanly,
- normalizing state, usage, and routing behaviour.

## Solution: Multi-Engine Provider Plugin

**sentinel-bridge** is an OpenClaw plugin that exposes Claude Code CLI, OpenAI Codex CLI, and Grok API as first-class engine providers. It:

1. **Wraps provider-specific engines behind a common interface.**
2. **Applies routing and fallback policy above individual engines.**
3. **Preserves session continuity** via engine-specific resume/state strategies.
4. **Provides a unified IEngine interface** so higher-level orchestration stays provider-agnostic.
5. **Tracks usage and cost metadata** for observability.

## User Stories

### US-1: Durable Routing
> As an OpenClaw user, I want my coding agent sessions routed to the right engine so that auth, capability, or runtime differences do not block my work.

### US-2: Multi-Engine Selection
> As a power user, I want to choose between Claude, Codex, and Grok engines per session so that I can pick the best model for each task.

### US-3: Session Persistence
> As a developer, I want coding sessions to persist across messages so that the engine retains context, working directory state, and conversation history.

### US-4: Cost Visibility
> As a cost-conscious user, I want per-session cost tracking with model-aware pricing so that I can monitor spend across engines.

### US-5: Fallback on Failure
> As a user, I want automatic fallback to an alternative engine when my primary engine fails or times out, so that my work isn't blocked.

### US-6: Model Aliases
> As a user, I want to use short aliases like `opus`, `sonnet`, `codex-mini`, `grok-3` instead of full model identifiers.

## Non-Goals

- **No Anthropic API proxy.** sentinel-bridge does NOT implement an HTTP proxy that translates Anthropic API calls. It wraps CLIs and APIs at the session level.
- **No web UI.** This is a headless OpenClaw plugin. UI is provided by OpenClaw's existing channels (Telegram, Discord, etc.).
- **No model fine-tuning or training.** Strictly inference orchestration.
- **No multi-tenant billing.** Single-user plugin. Cost tracking is informational, not a billing system.
- **No code copying from reference implementations.** Clean-room implementation only.

## Success Metrics

| Metric | Target |
|--------|--------|
| Session start fallback works when the primary engine is unavailable | 100% in covered test scenarios |
| Session start latency | < 3s for Claude, < 5s for Codex/Grok |
| Session message round-trip (excluding model thinking) | < 2s overhead |
| Engine fallback success rate | > 95% when fallback engine is configured |
| Cost tracking accuracy | ±5% vs actual API billing |
| Test coverage (unit) | > 80% |
| Zero additional dependencies beyond Node.js built-ins | Max 3 runtime deps |
