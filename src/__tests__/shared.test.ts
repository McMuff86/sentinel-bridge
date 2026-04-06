import { describe, expect, it } from 'vitest';

import {
  buildCompactPrompt,
  calculateLinearUsageCost,
  emptyTokenUsage,
  mergeEngineConfig,
  mergeTokenUsage,
  roundUsd,
  splitCachedInputTokens,
  toNumber,
  toOptionalNumber,
  toStringValue,
} from '../engines/shared.js';
import type { EngineConfig, ModelPricing } from '../types.js';

const BASE_CONFIG: EngineConfig = {
  command: 'claude',
  args: ['--verbose'],
  env: { FOO: 'bar' },
  model: 'claude-opus-4-6',
  cwd: '/tmp',
  timeoutMs: 5000,
};

describe('mergeEngineConfig', () => {
  it('returns a copy when no overrides are provided', () => {
    const merged = mergeEngineConfig(BASE_CONFIG);
    expect(merged).toEqual(BASE_CONFIG);
    expect(merged).not.toBe(BASE_CONFIG);
    // env should be a new object
    expect(merged.env).not.toBe(BASE_CONFIG.env);
  });

  it('overrides individual fields', () => {
    const merged = mergeEngineConfig(BASE_CONFIG, { model: 'claude-sonnet-4-5' });
    expect(merged.model).toBe('claude-sonnet-4-5');
    expect(merged.command).toBe('claude');
  });

  it('deep-merges env', () => {
    const merged = mergeEngineConfig(BASE_CONFIG, { env: { BAZ: 'qux' } });
    expect(merged.env).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('overrides args entirely', () => {
    const merged = mergeEngineConfig(BASE_CONFIG, { args: ['--quiet'] });
    expect(merged.args).toEqual(['--quiet']);
  });

  it('merges pricing fields', () => {
    const base: EngineConfig = { ...BASE_CONFIG, pricing: { inputPer1M: 10 } };
    const merged = mergeEngineConfig(base, { pricing: { outputPer1M: 20 } });
    expect(merged.pricing).toEqual({ inputPer1M: 10, outputPer1M: 20 });
  });
});

describe('emptyTokenUsage', () => {
  it('returns zeroed object', () => {
    expect(emptyTokenUsage()).toEqual({
      input: 0,
      output: 0,
      cachedInput: 0,
      total: 0,
    });
  });
});

describe('mergeTokenUsage', () => {
  it('adds delta to current', () => {
    const current = { input: 10, output: 5, cachedInput: 2, total: 17 };
    const result = mergeTokenUsage(current, { input: 3, output: 1, cachedInput: 0 });
    expect(result).toEqual({ input: 13, output: 6, cachedInput: 2, total: 21 });
  });

  it('returns copy when delta is undefined', () => {
    const current = { input: 10, output: 5, cachedInput: 2, total: 17 };
    const result = mergeTokenUsage(current);
    expect(result).toEqual(current);
    expect(result).not.toBe(current);
  });

  it('handles partial delta', () => {
    const current = { input: 10, output: 5, cachedInput: 0, total: 15 };
    const result = mergeTokenUsage(current, { output: 3 });
    expect(result).toEqual({ input: 10, output: 8, cachedInput: 0, total: 18 });
  });
});

describe('calculateLinearUsageCost', () => {
  const pricing: ModelPricing = {
    inputPer1M: 15,
    outputPer1M: 75,
    cachedInputPer1M: 1.5,
  };

  it('calculates cost for known usage', () => {
    const cost = calculateLinearUsageCost(pricing, {
      input: 1_000_000,
      output: 1_000_000,
      cachedInput: 0,
    });
    expect(cost).toBe(90); // 15 + 75
  });

  it('returns 0 for undefined delta', () => {
    expect(calculateLinearUsageCost(pricing)).toBe(0);
  });

  it('includes cached input cost', () => {
    const cost = calculateLinearUsageCost(pricing, {
      input: 0,
      output: 0,
      cachedInput: 1_000_000,
    });
    expect(cost).toBe(1.5);
  });
});

describe('splitCachedInputTokens', () => {
  it('splits normally when cached < total', () => {
    expect(splitCachedInputTokens(100, 30)).toEqual({
      input: 70,
      cachedInput: 30,
    });
  });

  it('handles cached > total (clamps input to 0)', () => {
    expect(splitCachedInputTokens(50, 80)).toEqual({
      input: 0,
      cachedInput: 80,
    });
  });

  it('handles zero cached', () => {
    expect(splitCachedInputTokens(100, 0)).toEqual({
      input: 100,
      cachedInput: 0,
    });
  });
});

describe('roundUsd', () => {
  it('rounds to 6 decimal places', () => {
    expect(roundUsd(0.1234567890)).toBe(0.123457);
  });

  it('handles clean values', () => {
    expect(roundUsd(1.5)).toBe(1.5);
  });

  it('handles floating point edge case (0.1 + 0.2)', () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
  });
});

describe('toNumber', () => {
  it('returns finite number as-is', () => {
    expect(toNumber(42)).toBe(42);
  });

  it('parses string to number', () => {
    expect(toNumber('123')).toBe(123);
  });

  it('returns 0 for non-numeric string', () => {
    expect(toNumber('abc')).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(toNumber(undefined)).toBe(0);
  });

  it('returns 0 for NaN', () => {
    expect(toNumber(NaN)).toBe(0);
  });

  it('returns 0 for Infinity', () => {
    expect(toNumber(Infinity)).toBe(0);
  });
});

describe('toOptionalNumber', () => {
  it('returns finite number', () => {
    expect(toOptionalNumber(42)).toBe(42);
  });

  it('parses numeric string', () => {
    expect(toOptionalNumber('3.14')).toBe(3.14);
  });

  it('returns undefined for non-numeric string', () => {
    expect(toOptionalNumber('abc')).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(toOptionalNumber(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(toOptionalNumber('')).toBeUndefined();
  });

  it('returns undefined for NaN number', () => {
    expect(toOptionalNumber(NaN)).toBeUndefined();
  });
});

describe('toStringValue', () => {
  it('returns non-empty string', () => {
    expect(toStringValue('hello')).toBe('hello');
  });

  it('returns undefined for empty string', () => {
    expect(toStringValue('')).toBeUndefined();
  });

  it('returns undefined for non-string', () => {
    expect(toStringValue(123)).toBeUndefined();
    expect(toStringValue(null)).toBeUndefined();
    expect(toStringValue(undefined)).toBeUndefined();
  });
});

describe('buildCompactPrompt', () => {
  it('returns default prompt without summary', () => {
    const prompt = buildCompactPrompt();
    expect(prompt).toContain('Compact the current session');
    expect(prompt).not.toContain('additional instruction');
  });

  it('includes summary when provided', () => {
    const prompt = buildCompactPrompt('Focus on the API changes');
    expect(prompt).toContain('additional instruction');
    expect(prompt).toContain('Focus on the API changes');
  });

  it('treats whitespace-only summary as empty', () => {
    const prompt = buildCompactPrompt('   ');
    expect(prompt).not.toContain('additional instruction');
  });
});
