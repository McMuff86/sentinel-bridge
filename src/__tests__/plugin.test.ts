import { describe, it, expect } from 'vitest';
import { PLUGIN_META, DEFAULT_CONFIG } from '../plugin.js';

describe('plugin metadata', () => {
  it('has correct name', () => {
    expect(PLUGIN_META.name).toBe('sentinel-bridge');
  });

  it('has MIT license', () => {
    expect(PLUGIN_META.license).toBe('MIT');
  });

  it('has version string', () => {
    expect(PLUGIN_META.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('default config', () => {
  it('has 4 engines configured', () => {
    expect(DEFAULT_CONFIG.engines).toBeDefined();
    expect(DEFAULT_CONFIG.engines!.claude).toBeDefined();
    expect(DEFAULT_CONFIG.engines!.codex).toBeDefined();
    expect(DEFAULT_CONFIG.engines!.grok).toBeDefined();
    expect(DEFAULT_CONFIG.engines!.ollama).toBeDefined();
  });

  it('claude and codex enabled by default, grok and ollama disabled', () => {
    expect(DEFAULT_CONFIG.engines!.claude!.enabled).toBe(true);
    expect(DEFAULT_CONFIG.engines!.codex!.enabled).toBe(true);
    expect(DEFAULT_CONFIG.engines!.grok!.enabled).toBe(false);
    expect(DEFAULT_CONFIG.engines!.ollama!.enabled).toBe(false);
  });

  it('has sensible session limits', () => {
    expect(DEFAULT_CONFIG.maxConcurrentSessions).toBeLessThanOrEqual(10);
    expect(DEFAULT_CONFIG.sessionTTLMs).toBeGreaterThan(0);
  });

  it('default model references claude', () => {
    expect(DEFAULT_CONFIG.defaultModel).toContain('claude');
  });

  it('defines default fallback chain claude then codex then grok then ollama', () => {
    expect(DEFAULT_CONFIG.defaultFallbackChain).toEqual([
      'claude',
      'codex',
      'grok',
      'ollama',
    ]);
  });
});
