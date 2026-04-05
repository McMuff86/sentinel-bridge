import type { EngineKind, SentinelBridgeConfig } from '../types.js';
import { DEFAULT_FALLBACK_CHAIN } from './model-aliases.js';

/**
 * Primary engine is always first; remaining engines follow plugin order without duplicates.
 */
export function expandFallbackChain(
  config: SentinelBridgeConfig,
  primary: EngineKind,
): EngineKind[] {
  const configured = config.defaultFallbackChain;
  const chain = configured === undefined ? DEFAULT_FALLBACK_CHAIN : configured;

  if (!chain.length) {
    return [primary];
  }

  const seen = new Set<EngineKind>();
  const ordered: EngineKind[] = [];

  if (!seen.has(primary)) {
    seen.add(primary);
    ordered.push(primary);
  }

  for (const engine of chain) {
    if (!seen.has(engine)) {
      seen.add(engine);
      ordered.push(engine);
    }
  }

  return ordered;
}
