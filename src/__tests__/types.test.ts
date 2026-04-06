import { describe, it, expect } from 'vitest';
import type { EngineState, EngineKind, ModelPricing, TokenUsage } from '../types.js';

describe('types', () => {
  it('EngineState includes all expected states', () => {
    const states: EngineState[] = ['idle', 'starting', 'running', 'stopping', 'stopped', 'error'];
    expect(states).toHaveLength(6);
  });

  it('EngineKind includes all engines', () => {
    const kinds: EngineKind[] = ['claude', 'codex', 'grok', 'ollama'];
    expect(kinds).toHaveLength(4);
  });

  it('ModelPricing has correct shape', () => {
    const pricing: ModelPricing = { inputPer1M: 15, outputPer1M: 75, cachedInputPer1M: 1.5 };
    expect(pricing.inputPer1M).toBe(15);
    expect(pricing.outputPer1M).toBe(75);
    expect(pricing.cachedInputPer1M).toBe(1.5);
  });

  it('TokenUsage tracks all token types', () => {
    const usage: TokenUsage = { input: 100, output: 200, cachedInput: 50, total: 350 };
    expect(usage.total).toBe(usage.input + usage.output + usage.cachedInput);
  });
});
