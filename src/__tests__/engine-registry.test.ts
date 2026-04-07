import { describe, it, expect } from 'vitest';
import { EngineRegistry } from '../engines/engine-registry.js';
import type { IEngineFactory } from '../engines/engine-contract.js';
import type { EngineConfig, IEngine, EngineStatusSnapshot } from '../types.js';
import { EngineError } from '../errors.js';

function stubEngine(): IEngine {
  return {
    async start() {},
    async send() { return 'ok'; },
    async compact() { return 'compacted'; },
    async stop() {},
    cancel() {},
    status(): EngineStatusSnapshot {
      return {
        state: 'idle',
        sessionId: null,
        model: 'stub',
        usage: { costUsd: 0, tokenCount: { input: 0, output: 0, cachedInput: 0, total: 0 } },
      };
    },
    getSessionId() { return null; },
  };
}

function customFactory(kind = 'custom-llm'): IEngineFactory {
  return {
    engineKind: kind,
    displayName: 'Custom LLM',
    transport: 'http',
    privacyLevel: 'local',
    create(_config: EngineConfig): IEngine {
      return stubEngine();
    },
  };
}

describe('EngineRegistry', () => {
  it('has 4 built-in engines', () => {
    const registry = new EngineRegistry();
    expect(registry.list()).toHaveLength(4);
  });

  it('has() returns true for built-in engines', () => {
    const registry = new EngineRegistry();
    expect(registry.has('claude')).toBe(true);
    expect(registry.has('codex')).toBe(true);
    expect(registry.has('grok')).toBe(true);
    expect(registry.has('ollama')).toBe(true);
  });

  it('has() returns false for unknown engine', () => {
    const registry = new EngineRegistry();
    expect(registry.has('unknown-engine')).toBe(false);
  });

  it('list() returns factories with correct metadata', () => {
    const registry = new EngineRegistry();
    const factories = registry.list();

    const claude = factories.find(f => f.engineKind === 'claude')!;
    expect(claude.displayName).toBe('Claude (Anthropic)');
    expect(claude.transport).toBe('subprocess');
    expect(claude.privacyLevel).toBe('cloud');

    const codex = factories.find(f => f.engineKind === 'codex')!;
    expect(codex.displayName).toBe('Codex (OpenAI)');
    expect(codex.transport).toBe('subprocess');
    expect(codex.privacyLevel).toBe('cloud');

    const grok = factories.find(f => f.engineKind === 'grok')!;
    expect(grok.displayName).toBe('Grok (xAI)');
    expect(grok.transport).toBe('http');
    expect(grok.privacyLevel).toBe('cloud');

    const ollama = factories.find(f => f.engineKind === 'ollama')!;
    expect(ollama.displayName).toBe('Ollama (Local)');
    expect(ollama.transport).toBe('http');
    expect(ollama.privacyLevel).toBe('local');
  });

  it('get() returns factory for known kind', () => {
    const registry = new EngineRegistry();
    const factory = registry.get('claude');
    expect(factory).toBeDefined();
    expect(factory!.engineKind).toBe('claude');
  });

  it('get() returns undefined for unknown kind', () => {
    const registry = new EngineRegistry();
    expect(registry.get('not-registered')).toBeUndefined();
  });

  it('create() creates an engine instance for ollama', () => {
    const registry = new EngineRegistry();
    const engine = registry.create('ollama', { model: 'test' });
    expect(engine).toBeDefined();
    expect(typeof engine.start).toBe('function');
    expect(typeof engine.send).toBe('function');
    expect(typeof engine.stop).toBe('function');
  });

  it('create() throws EngineError for unknown engine kind', () => {
    const registry = new EngineRegistry();
    expect(() => registry.create('nonexistent', { model: 'x' })).toThrow(EngineError);
    expect(() => registry.create('nonexistent', { model: 'x' })).toThrow(
      /Unknown engine kind "nonexistent"/,
    );
  });

  it('register() adds a custom engine', () => {
    const registry = new EngineRegistry();
    const factory = customFactory();
    registry.register(factory);
    expect(registry.has('custom-llm')).toBe(true);
    expect(registry.list()).toHaveLength(5);
    const engine = registry.create('custom-llm', { model: 'test' });
    expect(engine).toBeDefined();
  });

  it('register() throws if engineKind already registered', () => {
    const registry = new EngineRegistry();
    expect(() => registry.register(customFactory('claude'))).toThrow(EngineError);
    expect(() => registry.register(customFactory('claude'))).toThrow(
      /already registered/,
    );
  });

  it('register() throws for duplicate custom engine', () => {
    const registry = new EngineRegistry();
    registry.register(customFactory('my-engine'));
    expect(() => registry.register(customFactory('my-engine'))).toThrow(EngineError);
  });
});
