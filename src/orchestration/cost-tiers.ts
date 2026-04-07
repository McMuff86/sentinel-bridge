import type { EngineKind } from '../types.js';

export type CostTier = 'free' | 'low' | 'medium' | 'high';

export const ENGINE_COST_TIERS: Record<EngineKind, CostTier> = {
  ollama: 'free',
  grok: 'low',
  codex: 'medium',
  claude: 'high',
};

export function getEngineCostTier(
  engine: EngineKind,
  subscriptionCovered: boolean,
): CostTier {
  if (engine === 'claude' && subscriptionCovered) return 'free';
  return ENGINE_COST_TIERS[engine];
}
