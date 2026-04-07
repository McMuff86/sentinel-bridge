import type { EngineKind } from '../types.js';
import type { TaskCategory } from './task-classifier.js';
import type { KnnRouter } from './knn-router.js';

export interface BetaParams {
  alpha: number;  // success count + 1 (prior)
  beta: number;   // failure count + 1 (prior)
}

export interface RoutingStats {
  engine: EngineKind;
  category: string;
  params: BetaParams;
  ema: number;           // exponential moving average of success rate (0-1)
  sampleCount: number;
  lastUpdated: string;
}

export type RoutingStrategy = 'thompson' | 'ema' | 'blended' | 'knn' | 'ensemble' | 'static';

export interface AdaptiveRoutingResult {
  engine: EngineKind;
  confidence: number;     // 0-1, sampled value
  method: 'thompson' | 'ema' | 'blended' | 'knn' | 'ensemble' | 'static';
}

/**
 * Adaptive engine router using Thompson Sampling with Beta distributions.
 *
 * For each (engine, category) pair, maintains a Beta(alpha, beta) distribution
 * where alpha tracks successes and beta tracks failures. To select an engine,
 * samples from each engine's Beta distribution and picks the highest.
 */
export class AdaptiveRouter {
  private readonly stats = new Map<string, RoutingStats>();
  private readonly minSamples: number;
  private _strategy: RoutingStrategy = 'thompson';
  private readonly emaAlpha: number;
  private _knnRouter: KnnRouter | null = null;

  constructor(minSamples = 5, emaAlpha = 0.3) {
    this.minSamples = minSamples;
    this.emaAlpha = emaAlpha;
  }

  setKnnRouter(router: KnnRouter): void { this._knnRouter = router; }
  get knnRouter(): KnnRouter | null { return this._knnRouter; }

  get strategy(): RoutingStrategy { return this._strategy; }
  set strategy(s: RoutingStrategy) { this._strategy = s; }

  /**
   * Select engine using the configured strategy.
   * Falls back to null if not enough data (caller should use static routing).
   */
  selectEngine(
    category: TaskCategory,
    available: EngineKind[],
  ): AdaptiveRoutingResult | null {
    if (this._strategy === 'static') return null;

    // Check if we have enough samples for at least 2 engines in this category
    const candidates = available
      .map(engine => ({
        engine,
        stats: this.stats.get(this.key(engine, category)),
      }))
      .filter(c => c.stats && c.stats.sampleCount >= this.minSamples);

    if (candidates.length < 2) return null;  // Not enough data, use static

    switch (this._strategy) {
      case 'thompson':
      case 'knn':      // KNN/ensemble need async — fall back to thompson in sync context
      case 'ensemble':
        return this.selectByThompson(candidates as Array<{ engine: EngineKind; stats: RoutingStats }>);
      case 'ema':
        return this.selectByEma(candidates as Array<{ engine: EngineKind; stats: RoutingStats }>);
      case 'blended':
        return this.selectByBlended(candidates as Array<{ engine: EngineKind; stats: RoutingStats }>);
      default:
        return null;
    }
  }

  /**
   * Async engine selection — required for KNN and ensemble strategies
   * which need embedding lookups. Falls back to sync selectEngine for
   * strategies that don't require embeddings.
   */
  async selectEngineAsync(
    category: TaskCategory,
    available: EngineKind[],
    query?: string,
  ): Promise<AdaptiveRoutingResult | null> {
    // For non-KNN strategies, delegate to sync method
    if (this._strategy !== 'knn' && this._strategy !== 'ensemble') {
      return this.selectEngine(category, available);
    }

    if (!query || !this._knnRouter || !this._knnRouter.available) {
      // Fallback to sync (thompson) when KNN is unavailable
      return this.selectEngine(category, available);
    }

    if (this._strategy === 'knn') {
      const knnResult = await this._knnRouter.selectEngine(query, available);
      if (knnResult) {
        return { engine: knnResult.engine, confidence: knnResult.confidence, method: 'knn' };
      }
      // Fallback to Thompson
      return this.selectEngine(category, available);
    }

    if (this._strategy === 'ensemble') {
      // Weighted combination: Thompson + EMA + KNN
      const candidates = available
        .map(engine => ({
          engine,
          stats: this.stats.get(this.key(engine, category)),
        }))
        .filter(c => c.stats && c.stats.sampleCount >= this.minSamples);

      if (candidates.length < 2) return null;

      const knnResult = await this._knnRouter.selectEngine(query, available);

      let bestEngine = candidates[0]!.engine;
      let bestScore = -1;

      for (const { engine, stats } of candidates) {
        const thompsonSample = betaSample(stats!.params.alpha, stats!.params.beta);
        let score = 0.3 * thompsonSample + 0.4 * stats!.ema;
        // KNN bonus: if KNN picked this engine, add 0.3 weight
        if (knnResult && knnResult.engine === engine) {
          score += 0.3 * knnResult.confidence;
        }
        if (score > bestScore) {
          bestScore = score;
          bestEngine = engine;
        }
      }

      return { engine: bestEngine, confidence: bestScore, method: 'ensemble' };
    }

    return null;
  }

  private selectByThompson(candidates: Array<{ engine: EngineKind; stats: RoutingStats }>): AdaptiveRoutingResult {
    let bestEngine = candidates[0]!.engine;
    let bestSample = -1;

    for (const { engine, stats } of candidates) {
      const sample = betaSample(stats.params.alpha, stats.params.beta);
      if (sample > bestSample) {
        bestSample = sample;
        bestEngine = engine;
      }
    }

    return { engine: bestEngine, confidence: bestSample, method: 'thompson' };
  }

  private selectByEma(candidates: Array<{ engine: EngineKind; stats: RoutingStats }>): AdaptiveRoutingResult {
    let bestEngine = candidates[0]!.engine;
    let bestEma = -1;

    for (const { engine, stats } of candidates) {
      if (stats.ema > bestEma) {
        bestEma = stats.ema;
        bestEngine = engine;
      }
    }

    return { engine: bestEngine, confidence: bestEma, method: 'ema' };
  }

  private selectByBlended(candidates: Array<{ engine: EngineKind; stats: RoutingStats }>): AdaptiveRoutingResult {
    // 70% EMA (exploitation) + 30% Thompson (exploration)
    let bestEngine = candidates[0]!.engine;
    let bestScore = -1;

    for (const { engine, stats } of candidates) {
      const thompsonSample = betaSample(stats.params.alpha, stats.params.beta);
      const score = 0.7 * stats.ema + 0.3 * thompsonSample;
      if (score > bestScore) {
        bestScore = score;
        bestEngine = engine;
      }
    }

    return { engine: bestEngine, confidence: bestScore, method: 'blended' };
  }

  recordOutcome(engine: EngineKind, category: string, success: boolean): void {
    const k = this.key(engine, category);
    let stats = this.stats.get(k);
    if (!stats) {
      stats = {
        engine,
        category,
        params: { alpha: 1, beta: 1 },  // uniform prior
        ema: 0.5,                        // neutral prior
        sampleCount: 0,
        lastUpdated: new Date().toISOString(),
      };
      this.stats.set(k, stats);
    }

    if (success) {
      stats.params.alpha += 1;
    } else {
      stats.params.beta += 1;
    }

    // Update EMA
    const value = success ? 1 : 0;
    stats.ema = stats.ema * (1 - this.emaAlpha) + value * this.emaAlpha;

    stats.sampleCount += 1;
    stats.lastUpdated = new Date().toISOString();
  }

  /**
   * Bootstrap from historical outcome data.
   */
  loadFromOutcomes(outcomes: Array<{ engine: EngineKind; category: string; successes: number; failures: number }>): void {
    for (const outcome of outcomes) {
      const k = this.key(outcome.engine, outcome.category);
      this.stats.set(k, {
        engine: outcome.engine,
        category: outcome.category,
        params: {
          alpha: 1 + outcome.successes,   // prior + observed
          beta: 1 + outcome.failures,
        },
        ema: (outcome.successes + outcome.failures) > 0
          ? outcome.successes / (outcome.successes + outcome.failures)
          : 0.5,
        sampleCount: outcome.successes + outcome.failures,
        lastUpdated: new Date().toISOString(),
      });
    }
  }

  exportStats(): RoutingStats[] {
    return Array.from(this.stats.values());
  }

  importStats(stats: RoutingStats[]): void {
    this.stats.clear();
    for (const s of stats) {
      this.stats.set(this.key(s.engine, s.category), s);
    }
  }

  getStats(engine?: EngineKind, category?: string): RoutingStats[] {
    return Array.from(this.stats.values()).filter(s => {
      if (engine && s.engine !== engine) return false;
      if (category && s.category !== category) return false;
      return true;
    });
  }

  private key(engine: string, category: string): string {
    return `${engine}:${category}`;
  }
}

/* ── Beta distribution sampling (zero dependencies) ────────────── */

/**
 * Sample from Beta(alpha, beta) using the Gamma distribution method.
 * Generate X ~ Gamma(alpha, 1) and Y ~ Gamma(beta, 1), then X / (X + Y) ~ Beta(alpha, beta).
 */
export function betaSample(alpha: number, beta: number): number {
  // Edge cases
  if (alpha <= 0 || beta <= 0) return 0.5;

  // For alpha=1, beta=1 (uniform): just return random
  if (alpha === 1 && beta === 1) return Math.random();

  const x = gammaSample(alpha);
  const y = gammaSample(beta);
  if (x + y === 0) return 0.5;
  return x / (x + y);
}

/**
 * Sample from Gamma(shape, 1) using Marsaglia and Tsang's method.
 */
function gammaSample(shape: number): number {
  if (shape < 1) {
    // For shape < 1, use the relation: Gamma(shape) = Gamma(shape+1) * U^(1/shape)
    return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  while (true) {
    let x: number;
    let v: number;

    do {
      x = normalSample();
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = Math.random();

    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Box-Muller transform for normal distribution sampling.
 */
function normalSample(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
