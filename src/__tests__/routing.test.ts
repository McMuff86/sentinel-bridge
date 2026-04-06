import { describe, expect, it } from 'vitest';

import { resolveModelRoute, resolveDefaultRoute } from '../routing/resolve-model-route.js';
import { expandFallbackChain } from '../routing/expand-fallback-chain.js';
import { selectPrimaryEngine } from '../routing/select-engine.js';
import type { EngineConfig, EngineKind, SentinelBridgeConfig } from '../types.js';

/* ── Helpers ──────────────────────────────────────────────────── */

const FALLBACK_MODELS: Record<EngineKind, string> = {
  claude: 'claude-opus-4-6',
  codex: 'gpt-5.4',
  grok: 'grok-4-1-fast',
  ollama: 'llama3.2',
};

const ENGINE_DEFAULTS: Record<EngineKind, Partial<EngineConfig>> = {
  claude: { model: 'claude-sonnet-4-5' },
  codex: { model: 'gpt-5.4' },
  grok: { model: 'grok-4-1-fast' },
  ollama: { model: 'llama3.2' },
};

const getEngineDefaults = (engine: EngineKind) => ENGINE_DEFAULTS[engine];
const getFallbackModel = (engine: EngineKind) => FALLBACK_MODELS[engine];

function resolve(
  model: string,
  preferredEngine?: EngineKind,
  config: SentinelBridgeConfig = {},
) {
  return resolveModelRoute(config, getEngineDefaults, getFallbackModel, model, preferredEngine);
}

function resolveDefault(
  preferredEngine?: EngineKind,
  config: SentinelBridgeConfig = {},
) {
  return resolveDefaultRoute(config, getEngineDefaults, getFallbackModel, preferredEngine);
}

/* ── resolveModelRoute ────────────────────────────────────────── */

describe('resolveModelRoute', () => {
  it('resolves alias "opus" to claude-opus-4-6 on claude engine', () => {
    const route = resolve('opus');
    expect(route.model).toBe('claude-opus-4-6');
    expect(route.engine).toBe('claude');
    expect(route.source).toBe('alias');
  });

  it('resolves alias "sonnet" to claude-sonnet-4-5', () => {
    const route = resolve('sonnet');
    expect(route.model).toBe('claude-sonnet-4-5');
    expect(route.engine).toBe('claude');
  });

  it('resolves alias "codex" to gpt-5.4 on codex engine', () => {
    const route = resolve('codex');
    expect(route.model).toBe('gpt-5.4');
    expect(route.engine).toBe('codex');
  });

  it('resolves alias "grok-3" to grok-3 on grok engine', () => {
    const route = resolve('grok-3');
    expect(route.model).toBe('grok-3');
    expect(route.engine).toBe('grok');
  });

  it('resolves alias "llama3" to llama3.2 on ollama engine', () => {
    const route = resolve('llama3');
    expect(route.model).toBe('llama3.2');
    expect(route.engine).toBe('ollama');
  });

  it('parses "claude/opus" engine prefix syntax', () => {
    const route = resolve('claude/opus');
    expect(route.model).toBe('claude-opus-4-6');
    expect(route.engine).toBe('claude');
  });

  it('parses "grok/grok-3" engine prefix syntax', () => {
    const route = resolve('grok/grok-3');
    expect(route.model).toBe('grok-3');
    expect(route.engine).toBe('grok');
  });

  it('parses "ollama/mistral" engine prefix syntax', () => {
    const route = resolve('ollama/mistral');
    expect(route.model).toBe('mistral');
    expect(route.engine).toBe('ollama');
  });

  it('infers claude engine from claude- model prefix', () => {
    const route = resolve('claude-haiku-4');
    expect(route.engine).toBe('claude');
  });

  it('infers codex engine from gpt- model prefix', () => {
    const route = resolve('gpt-5.4');
    expect(route.engine).toBe('codex');
  });

  it('infers codex engine from o4- model prefix', () => {
    const route = resolve('o4-mini');
    expect(route.engine).toBe('codex');
  });

  it('infers grok engine from grok- model prefix', () => {
    const route = resolve('grok-4-1-fast');
    expect(route.engine).toBe('grok');
  });

  it('infers ollama engine from llama model prefix', () => {
    const route = resolve('llama3.1');
    expect(route.engine).toBe('ollama');
  });

  it('infers ollama engine from deepseek prefix', () => {
    const route = resolve('deepseek-r1');
    expect(route.engine).toBe('ollama');
  });

  it('returns explicit source for unknown model passed directly', () => {
    const route = resolve('my-custom-model', 'claude');
    expect(route.source).toBe('explicit');
    expect(route.model).toBe('my-custom-model');
  });

  it('uses defaultEngine when model cannot be inferred', () => {
    const route = resolve('some-unknown-model', undefined, { defaultEngine: 'grok' });
    expect(route.engine).toBe('grok');
  });

  it('falls back to claude when no defaultEngine set and model is unknown', () => {
    const route = resolve('some-unknown-model');
    expect(route.engine).toBe('claude');
  });

  it('throws when engine prefix conflicts with preferredEngine', () => {
    expect(() => resolve('claude/opus', 'codex')).toThrow(/does not match/);
  });

  it('throws when inferred engine conflicts with preferredEngine', () => {
    expect(() => resolve('gpt-5.4', 'claude')).toThrow(/does not match/);
  });

  it('falls back to default route for empty model string', () => {
    const route = resolve('');
    expect(route.source).toBe('default');
  });

  it('falls back to default route for whitespace-only model', () => {
    const route = resolve('   ');
    expect(route.source).toBe('default');
  });

  it('marks claude as subscription covered', () => {
    const route = resolve('opus');
    expect(route.subscriptionCovered).toBe(true);
  });

  it('marks grok as not subscription covered', () => {
    const route = resolve('grok-3');
    expect(route.subscriptionCovered).toBe(false);
  });
});

/* ── resolveDefaultRoute ──────────────────────────────────────── */

describe('resolveDefaultRoute', () => {
  it('uses config.defaultModel when set', () => {
    const route = resolveDefault(undefined, { defaultModel: 'claude/sonnet' });
    expect(route.source).toBe('default');
    expect(route.engine).toBe('claude');
  });

  it('falls back to engine defaults', () => {
    const route = resolveDefault('codex');
    expect(route.model).toBe('gpt-5.4');
    expect(route.engine).toBe('codex');
    expect(route.source).toBe('default');
  });

  it('falls back to claude when nothing is configured', () => {
    const route = resolveDefault();
    expect(route.engine).toBe('claude');
    expect(route.source).toBe('default');
  });

  it('respects preferredEngine over defaultModel engine', () => {
    const route = resolveDefault('grok', { defaultModel: 'claude/opus' });
    // When preferred engine conflicts with defaultModel engine, should fall through
    expect(route.engine).toBe('grok');
  });
});

/* ── expandFallbackChain ──────────────────────────────────────── */

describe('expandFallbackChain', () => {
  it('puts primary engine first', () => {
    const chain = expandFallbackChain({}, 'codex');
    expect(chain[0]).toBe('codex');
  });

  it('deduplicates primary from the default chain', () => {
    const chain = expandFallbackChain({}, 'claude');
    expect(chain.filter((e) => e === 'claude')).toHaveLength(1);
  });

  it('returns only [primary] when chain is empty', () => {
    const chain = expandFallbackChain({ defaultFallbackChain: [] }, 'grok');
    expect(chain).toEqual(['grok']);
  });

  it('respects custom chain order', () => {
    const chain = expandFallbackChain(
      { defaultFallbackChain: ['ollama', 'grok'] },
      'codex',
    );
    expect(chain).toEqual(['codex', 'ollama', 'grok']);
  });

  it('deduplicates across custom chain', () => {
    const chain = expandFallbackChain(
      { defaultFallbackChain: ['claude', 'claude', 'grok'] },
      'claude',
    );
    expect(chain).toEqual(['claude', 'grok']);
  });
});

/* ── selectPrimaryEngine ──────────────────────────────────────── */

describe('selectPrimaryEngine', () => {
  it('returns explicit engine from options', () => {
    const engine = selectPrimaryEngine({}, { name: 'test', engine: 'grok' });
    expect(engine).toBe('grok');
  });

  it('returns routed engine when no explicit engine', () => {
    const engine = selectPrimaryEngine({}, { name: 'test' }, 'codex');
    expect(engine).toBe('codex');
  });

  it('picks resume-capable engine (claude) for resumeSessionId', () => {
    const engine = selectPrimaryEngine(
      { defaultEngine: 'codex' },
      { name: 'test', resumeSessionId: 'sess-123' },
    );
    // claude supports resume, codex does not → should pick claude from chain
    expect(engine).toBe('claude');
  });

  it('picks cwd-capable engine when cwd is set', () => {
    const engine = selectPrimaryEngine(
      { defaultEngine: 'grok' },
      { name: 'test', cwd: '/workspace' },
    );
    // grok doesn't support cwd; claude and codex do; claude is first in default chain
    expect(engine).toBe('claude');
  });

  it('defaults to config.defaultEngine', () => {
    const engine = selectPrimaryEngine(
      { defaultEngine: 'ollama' },
      { name: 'test' },
    );
    expect(engine).toBe('ollama');
  });

  it('defaults to claude when nothing is configured', () => {
    const engine = selectPrimaryEngine({}, { name: 'test' });
    expect(engine).toBe('claude');
  });
});
