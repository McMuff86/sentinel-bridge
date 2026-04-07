import { describe, it, expect } from 'vitest';
import { AdaptiveRouter, betaSample } from '../orchestration/adaptive-router.js';
import type { RoutingStats } from '../orchestration/adaptive-router.js';
import type { EngineKind } from '../types.js';

describe('AdaptiveRouter', () => {
  describe('recordOutcome', () => {
    it('creates stats with correct alpha/beta increments on success', () => {
      const router = new AdaptiveRouter();
      router.recordOutcome('claude', 'code_generation', true);

      const stats = router.getStats('claude', 'code_generation');
      expect(stats).toHaveLength(1);
      expect(stats[0]!.params.alpha).toBe(2); // 1 (prior) + 1
      expect(stats[0]!.params.beta).toBe(1);  // 1 (prior)
      expect(stats[0]!.sampleCount).toBe(1);
    });

    it('creates stats with correct alpha/beta increments on failure', () => {
      const router = new AdaptiveRouter();
      router.recordOutcome('codex', 'reasoning', false);

      const stats = router.getStats('codex', 'reasoning');
      expect(stats).toHaveLength(1);
      expect(stats[0]!.params.alpha).toBe(1);  // 1 (prior)
      expect(stats[0]!.params.beta).toBe(2);   // 1 (prior) + 1
      expect(stats[0]!.sampleCount).toBe(1);
    });

    it('accumulates outcomes over multiple calls', () => {
      const router = new AdaptiveRouter();
      router.recordOutcome('claude', 'code_generation', true);
      router.recordOutcome('claude', 'code_generation', true);
      router.recordOutcome('claude', 'code_generation', true);
      router.recordOutcome('claude', 'code_generation', false);

      const stats = router.getStats('claude', 'code_generation');
      expect(stats).toHaveLength(1);
      expect(stats[0]!.params.alpha).toBe(4); // 1 + 3
      expect(stats[0]!.params.beta).toBe(2);  // 1 + 1
      expect(stats[0]!.sampleCount).toBe(4);
    });

    it('tracks separate categories independently', () => {
      const router = new AdaptiveRouter();
      router.recordOutcome('claude', 'code_generation', true);
      router.recordOutcome('claude', 'reasoning', false);

      const codeStats = router.getStats('claude', 'code_generation');
      const reasonStats = router.getStats('claude', 'reasoning');
      expect(codeStats).toHaveLength(1);
      expect(reasonStats).toHaveLength(1);
      expect(codeStats[0]!.params.alpha).toBe(2);
      expect(reasonStats[0]!.params.beta).toBe(2);
    });
  });

  describe('selectEngine', () => {
    it('returns null when not enough samples', () => {
      const router = new AdaptiveRouter(5);
      // Only 2 outcomes per engine, below minSamples=5
      router.recordOutcome('claude', 'code_generation', true);
      router.recordOutcome('claude', 'code_generation', true);
      router.recordOutcome('codex', 'code_generation', true);
      router.recordOutcome('codex', 'code_generation', true);

      const result = router.selectEngine('code_generation', ['claude', 'codex']);
      expect(result).toBeNull();
    });

    it('returns null when only one engine has enough data', () => {
      const router = new AdaptiveRouter(3);
      for (let i = 0; i < 5; i++) {
        router.recordOutcome('claude', 'code_generation', true);
      }
      router.recordOutcome('codex', 'code_generation', true);

      const result = router.selectEngine('code_generation', ['claude', 'codex']);
      expect(result).toBeNull();
    });

    it('returns a valid engine when enough samples exist', () => {
      const router = new AdaptiveRouter(3);
      for (let i = 0; i < 5; i++) {
        router.recordOutcome('claude', 'code_generation', true);
        router.recordOutcome('codex', 'code_generation', true);
      }

      const result = router.selectEngine('code_generation', ['claude', 'codex']);
      expect(result).not.toBeNull();
      expect(result!.method).toBe('thompson');
      expect(result!.confidence).toBeGreaterThanOrEqual(0);
      expect(result!.confidence).toBeLessThanOrEqual(1);
      expect(['claude', 'codex']).toContain(result!.engine);
    });

    it('tends to favor engine with higher success rate over 100 trials', () => {
      const router = new AdaptiveRouter(3);
      // Claude: 90% success rate
      for (let i = 0; i < 9; i++) router.recordOutcome('claude', 'code_generation', true);
      router.recordOutcome('claude', 'code_generation', false);
      // Codex: 30% success rate
      for (let i = 0; i < 3; i++) router.recordOutcome('codex', 'code_generation', true);
      for (let i = 0; i < 7; i++) router.recordOutcome('codex', 'code_generation', false);

      const counts: Record<string, number> = { claude: 0, codex: 0 };
      for (let i = 0; i < 100; i++) {
        const result = router.selectEngine('code_generation', ['claude', 'codex']);
        expect(result).not.toBeNull();
        counts[result!.engine] = (counts[result!.engine] ?? 0) + 1;
      }

      // Claude should be selected significantly more often
      expect(counts['claude']).toBeGreaterThan(counts['codex']!);
      // At 90% vs 30%, claude should win the vast majority of the time
      expect(counts['claude']).toBeGreaterThan(60);
    });

    it('only considers available engines', () => {
      const router = new AdaptiveRouter(3);
      for (let i = 0; i < 5; i++) {
        router.recordOutcome('claude', 'code_generation', true);
        router.recordOutcome('codex', 'code_generation', true);
        router.recordOutcome('grok', 'code_generation', true);
      }

      // Only pass claude and grok as available
      const result = router.selectEngine('code_generation', ['claude', 'grok']);
      expect(result).not.toBeNull();
      expect(['claude', 'grok']).toContain(result!.engine);
    });
  });

  describe('loadFromOutcomes', () => {
    it('bootstraps from historical data', () => {
      const router = new AdaptiveRouter();
      router.loadFromOutcomes([
        { engine: 'claude', category: 'code_generation', successes: 10, failures: 2 },
        { engine: 'codex', category: 'code_generation', successes: 8, failures: 4 },
      ]);

      const stats = router.getStats();
      expect(stats).toHaveLength(2);

      const claudeStats = stats.find(s => s.engine === 'claude')!;
      expect(claudeStats.params.alpha).toBe(11); // 1 + 10
      expect(claudeStats.params.beta).toBe(3);   // 1 + 2
      expect(claudeStats.sampleCount).toBe(12);

      const codexStats = stats.find(s => s.engine === 'codex')!;
      expect(codexStats.params.alpha).toBe(9);  // 1 + 8
      expect(codexStats.params.beta).toBe(5);   // 1 + 4
      expect(codexStats.sampleCount).toBe(12);
    });
  });

  describe('exportStats / importStats', () => {
    it('roundtrips stats correctly', () => {
      const router = new AdaptiveRouter();
      router.recordOutcome('claude', 'code_generation', true);
      router.recordOutcome('claude', 'code_generation', true);
      router.recordOutcome('codex', 'reasoning', false);

      const exported = router.exportStats();
      expect(exported).toHaveLength(2);

      const router2 = new AdaptiveRouter();
      router2.importStats(exported);

      const reimported = router2.exportStats();
      expect(reimported).toHaveLength(2);

      for (const original of exported) {
        const found = reimported.find(
          s => s.engine === original.engine && s.category === original.category,
        );
        expect(found).toBeDefined();
        expect(found!.params.alpha).toBe(original.params.alpha);
        expect(found!.params.beta).toBe(original.params.beta);
        expect(found!.sampleCount).toBe(original.sampleCount);
      }
    });

    it('importStats clears previous state', () => {
      const router = new AdaptiveRouter();
      router.recordOutcome('grok', 'fast_task', true);
      expect(router.exportStats()).toHaveLength(1);

      router.importStats([]);
      expect(router.exportStats()).toHaveLength(0);
    });
  });

  describe('getStats', () => {
    it('filters by engine', () => {
      const router = new AdaptiveRouter();
      router.recordOutcome('claude', 'code_generation', true);
      router.recordOutcome('codex', 'code_generation', true);
      router.recordOutcome('claude', 'reasoning', true);

      const claudeStats = router.getStats('claude');
      expect(claudeStats).toHaveLength(2);
      expect(claudeStats.every(s => s.engine === 'claude')).toBe(true);
    });

    it('filters by category', () => {
      const router = new AdaptiveRouter();
      router.recordOutcome('claude', 'code_generation', true);
      router.recordOutcome('codex', 'code_generation', true);
      router.recordOutcome('claude', 'reasoning', true);

      const codeStats = router.getStats(undefined, 'code_generation');
      expect(codeStats).toHaveLength(2);
      expect(codeStats.every(s => s.category === 'code_generation')).toBe(true);
    });

    it('filters by both engine and category', () => {
      const router = new AdaptiveRouter();
      router.recordOutcome('claude', 'code_generation', true);
      router.recordOutcome('codex', 'code_generation', true);
      router.recordOutcome('claude', 'reasoning', true);

      const specific = router.getStats('claude', 'code_generation');
      expect(specific).toHaveLength(1);
      expect(specific[0]!.engine).toBe('claude');
      expect(specific[0]!.category).toBe('code_generation');
    });

    it('returns all stats when no filters given', () => {
      const router = new AdaptiveRouter();
      router.recordOutcome('claude', 'code_generation', true);
      router.recordOutcome('codex', 'code_generation', true);

      expect(router.getStats()).toHaveLength(2);
    });
  });
});

describe('EMA strategy', () => {
  it('selectByEma picks engine with highest EMA', () => {
    const router = new AdaptiveRouter(3);
    router.strategy = 'ema';
    // Claude: all success (EMA trends to 1.0)
    for (let i = 0; i < 10; i++) router.recordOutcome('claude', 'code_generation', true);
    // Codex: all failure (EMA trends to 0.0)
    for (let i = 0; i < 10; i++) router.recordOutcome('codex', 'code_generation', false);

    const result = router.selectEngine('code_generation', ['claude', 'codex']);
    expect(result).not.toBeNull();
    expect(result!.engine).toBe('claude');
    expect(result!.method).toBe('ema');
  });

  it('EMA updates correctly with mixed outcomes', () => {
    const router = new AdaptiveRouter(1, 0.5); // high alpha for clear updates
    router.recordOutcome('claude', 'code_generation', true);  // ema: 0.5 * 0.5 + 1 * 0.5 = 0.75
    router.recordOutcome('claude', 'code_generation', false); // ema: 0.75 * 0.5 + 0 * 0.5 = 0.375

    const stats = router.getStats('claude', 'code_generation');
    expect(stats[0]!.ema).toBeCloseTo(0.375);
  });
});

describe('blended strategy', () => {
  it('selectByBlended returns blended method', () => {
    const router = new AdaptiveRouter(3);
    router.strategy = 'blended';
    for (let i = 0; i < 10; i++) {
      router.recordOutcome('claude', 'code_generation', true);
      router.recordOutcome('codex', 'code_generation', true);
    }

    const result = router.selectEngine('code_generation', ['claude', 'codex']);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('blended');
  });
});

describe('strategy property', () => {
  it('defaults to thompson', () => {
    const router = new AdaptiveRouter();
    expect(router.strategy).toBe('thompson');
  });

  it('can be changed', () => {
    const router = new AdaptiveRouter();
    router.strategy = 'ema';
    expect(router.strategy).toBe('ema');
  });

  it('static strategy returns null from selectEngine', () => {
    const router = new AdaptiveRouter(1);
    router.strategy = 'static';
    for (let i = 0; i < 10; i++) {
      router.recordOutcome('claude', 'code_generation', true);
      router.recordOutcome('codex', 'code_generation', true);
    }
    expect(router.selectEngine('code_generation', ['claude', 'codex'])).toBeNull();
  });
});

describe('betaSample', () => {
  it('produces values in [0, 1] range', () => {
    for (let i = 0; i < 200; i++) {
      const sample = betaSample(2, 3);
      expect(sample).toBeGreaterThanOrEqual(0);
      expect(sample).toBeLessThanOrEqual(1);
    }
  });

  it('handles edge case alpha=0', () => {
    expect(betaSample(0, 1)).toBe(0.5);
  });

  it('handles edge case beta=0', () => {
    expect(betaSample(1, 0)).toBe(0.5);
  });

  it('produces uniform-like distribution for alpha=1, beta=1', () => {
    const samples: number[] = [];
    for (let i = 0; i < 500; i++) {
      samples.push(betaSample(1, 1));
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    // Uniform [0,1] has mean 0.5 — should be within reasonable range
    expect(mean).toBeGreaterThan(0.3);
    expect(mean).toBeLessThan(0.7);
  });

  it('produces higher mean for higher alpha', () => {
    const highAlpha: number[] = [];
    const highBeta: number[] = [];
    for (let i = 0; i < 500; i++) {
      highAlpha.push(betaSample(10, 2));
      highBeta.push(betaSample(2, 10));
    }
    const meanHigh = highAlpha.reduce((a, b) => a + b, 0) / highAlpha.length;
    const meanLow = highBeta.reduce((a, b) => a + b, 0) / highBeta.length;
    // Beta(10,2) mean ~= 0.833, Beta(2,10) mean ~= 0.167
    expect(meanHigh).toBeGreaterThan(meanLow);
    expect(meanHigh).toBeGreaterThan(0.6);
    expect(meanLow).toBeLessThan(0.4);
  });

  it('works with fractional parameters', () => {
    for (let i = 0; i < 100; i++) {
      const sample = betaSample(0.5, 0.5);
      expect(sample).toBeGreaterThanOrEqual(0);
      expect(sample).toBeLessThanOrEqual(1);
    }
  });
});
