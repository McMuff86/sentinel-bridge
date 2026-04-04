# PRD — sentinel-bridge

## Problem Statement

**Effective April 4, 2026**, Anthropic bills third-party harness usage of Claude models separately from existing subscriptions. Users who interact with Claude through external tools (OpenClaw, Cursor, etc.) will incur additional API costs even when they already hold a Claude Pro/Max subscription.

However, **Claude Code CLI** — Anthropic's own terminal agent — remains fully covered by the subscription. A Claude Max subscriber can run unlimited Claude Code sessions at no extra charge.

This creates a clear arbitrage opportunity: if an orchestration layer routes its requests _through_ Claude Code CLI instead of hitting the Anthropic API directly, the subscription covers the usage and no additional billing applies.

## Solution: Multi-Engine Provider Plugin

**sentinel-bridge** is an OpenClaw plugin that exposes Claude Code CLI, OpenAI Codex CLI, and Grok API as first-class engine providers. It:

1. **Routes OpenClaw requests through Claude Code CLI** — leveraging subscription auth so Claude usage costs zero extra.
2. **Wraps Codex CLI** — full OpenAI Codex integration with session persistence via working directory state.
3. **Wraps Grok API** — xAI's Grok models as an additional engine option.
4. **Provides a unified IEngine interface** — all engines look the same to OpenClaw's session management.
5. **Tracks cost** — per-session and per-engine cost breakdown, even when the actual billing is $0 (subscription).

## User Stories

### US-1: Zero-Cost Claude Usage
> As an OpenClaw user with a Claude Max subscription, I want my coding agent requests routed through Claude Code CLI so that I pay nothing beyond my existing subscription.

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
| Claude requests via subscription (not billed separately) | 100% when Claude Code CLI is available |
| Session start latency | < 3s for Claude, < 5s for Codex/Grok |
| Session message round-trip (excluding model thinking) | < 2s overhead |
| Engine fallback success rate | > 95% when fallback engine is configured |
| Cost tracking accuracy | ±5% vs actual API billing |
| Test coverage (unit) | > 80% |
| Zero additional dependencies beyond Node.js built-ins | Max 3 runtime deps |
