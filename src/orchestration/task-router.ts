import type { EngineKind } from '../types.js';
import { classifyTask } from './task-classifier.js';
import type { TaskCategory, TaskClassification } from './task-classifier.js';
import { getEngineCostTier } from './cost-tiers.js';
import type { CostTier } from './cost-tiers.js';
import type { AdaptiveRouter } from './adaptive-router.js';

export interface EngineAvailability {
  engine: EngineKind;
  available: boolean;
  healthy: boolean;
}

export interface TaskRoutingAlternative {
  engine: EngineKind;
  model: string;
  reasoning: string;
  estimatedCostTier: CostTier;
}

export interface TaskRoutingResult {
  classification: TaskClassification;
  recommendedEngine: EngineKind;
  recommendedModel: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  alternatives: TaskRoutingAlternative[];
  costTier: CostTier;
  method: 'thompson' | 'static';
}

interface EngineStrength {
  engine: EngineKind;
  defaultModel: string;
  codeStrength: number;
  reasoningStrength: number;
  speedTier: number;
  privacyLevel: 'cloud' | 'local';
}

const ENGINE_STRENGTHS: EngineStrength[] = [
  {
    engine: 'claude',
    defaultModel: 'claude-opus-4-6',
    codeStrength: 9,
    reasoningStrength: 10,
    speedTier: 5,
    privacyLevel: 'cloud',
  },
  {
    engine: 'codex',
    defaultModel: 'gpt-5.4',
    codeStrength: 10,
    reasoningStrength: 8,
    speedTier: 6,
    privacyLevel: 'cloud',
  },
  {
    engine: 'grok',
    defaultModel: 'grok-4-1-fast',
    codeStrength: 6,
    reasoningStrength: 7,
    speedTier: 9,
    privacyLevel: 'cloud',
  },
  {
    engine: 'ollama',
    defaultModel: 'llama3.2',
    codeStrength: 5,
    reasoningStrength: 5,
    speedTier: 7,
    privacyLevel: 'local',
  },
];

type RoutingPreference = 'fast' | 'cheap' | 'capable';

function scoreEngine(
  strength: EngineStrength,
  category: TaskCategory,
  prefer?: RoutingPreference,
): number {
  let score = 0;

  switch (category) {
    case 'code_generation':
      score += strength.codeStrength * 2;
      score += strength.reasoningStrength;
      break;
    case 'code_review':
      score += strength.reasoningStrength * 2;
      score += strength.codeStrength;
      break;
    case 'reasoning':
      score += strength.reasoningStrength * 3;
      break;
    case 'fast_task':
      score += strength.speedTier * 3;
      break;
    case 'creative':
      score += strength.reasoningStrength * 2;
      score += strength.speedTier;
      break;
    case 'local_private':
      score += strength.privacyLevel === 'local' ? 100 : 0;
      break;
    case 'general':
      score += strength.reasoningStrength;
      score += strength.codeStrength;
      score += strength.speedTier;
      break;
  }

  // Apply preference modifiers
  if (prefer === 'fast') {
    score += strength.speedTier * 2;
  } else if (prefer === 'cheap') {
    // Ollama is free, grok is cheapest cloud
    const costBonus: Record<EngineKind, number> = {
      ollama: 20, grok: 10, codex: 5, claude: 0,
    };
    score += costBonus[strength.engine];
  } else if (prefer === 'capable') {
    score += strength.reasoningStrength * 2;
    score += strength.codeStrength;
  }

  return score;
}

function confidenceFromClassification(classification: TaskClassification): 'high' | 'medium' | 'low' {
  if (classification.primary === 'general') return 'low';
  if (classification.signals.length >= 3) return 'high';
  if (classification.signals.length >= 1) return 'medium';
  return 'low';
}

function reasoningForCategory(category: TaskCategory, engine: EngineKind): string {
  const reasons: Record<TaskCategory, Record<string, string>> = {
    code_generation: {
      codex: 'Codex excels at code generation with strong code-specific training.',
      claude: 'Claude provides excellent code generation with strong reasoning.',
      grok: 'Grok can generate code quickly at lower cost.',
      ollama: 'Ollama provides local code generation with no cloud dependency.',
    },
    code_review: {
      claude: 'Claude excels at nuanced code analysis and security review.',
      codex: 'Codex has strong code understanding for review tasks.',
      grok: 'Grok offers fast code review at lower cost.',
      ollama: 'Ollama enables private code review without cloud exposure.',
    },
    reasoning: {
      claude: 'Claude has the strongest reasoning capabilities for complex analysis.',
      codex: 'Codex offers solid reasoning for technical decisions.',
      grok: 'Grok provides fast reasoning at lower cost.',
      ollama: 'Ollama enables private reasoning without cloud dependency.',
    },
    fast_task: {
      grok: 'Grok is the fastest engine for simple, quick tasks.',
      ollama: 'Ollama provides fast local inference for simple tasks.',
      claude: 'Claude handles simple tasks well but may be slower.',
      codex: 'Codex is capable but may be slower for simple tasks.',
    },
    creative: {
      claude: 'Claude excels at creative and nuanced text generation.',
      grok: 'Grok offers fast creative output at lower cost.',
      codex: 'Codex can handle creative tasks with technical flair.',
      ollama: 'Ollama provides local creative text generation.',
    },
    local_private: {
      ollama: 'Ollama runs entirely locally — no data leaves your machine.',
      claude: 'Note: Claude sends data to cloud. Use Ollama for privacy.',
      codex: 'Note: Codex sends data to cloud. Use Ollama for privacy.',
      grok: 'Note: Grok sends data to cloud. Use Ollama for privacy.',
    },
    general: {
      claude: 'Claude is the most versatile engine for general tasks.',
      codex: 'Codex offers strong all-around performance.',
      grok: 'Grok provides fast general-purpose assistance.',
      ollama: 'Ollama offers local general-purpose inference.',
    },
  };

  return reasons[category]?.[engine] ?? `${engine} selected for ${category} task.`;
}

export function routeTask(
  description: string,
  getAvailability: (engine: EngineKind) => EngineAvailability,
  prefer?: RoutingPreference,
  adaptiveRouter?: AdaptiveRouter,
): TaskRoutingResult {
  const classification = classifyTask(description);

  // Try adaptive routing first
  if (adaptiveRouter) {
    const availableEngines = ENGINE_STRENGTHS
      .filter(s => {
        const a = getAvailability(s.engine);
        return a.available && a.healthy;
      })
      .map(s => s.engine);

    const adaptive = adaptiveRouter.selectEngine(classification.primary, availableEngines);
    if (adaptive) {
      const strength = ENGINE_STRENGTHS.find(s => s.engine === adaptive.engine)!;

      // Build alternatives from static scoring for the remaining engines
      const scored = ENGINE_STRENGTHS
        .filter(s => s.engine !== adaptive.engine)
        .map(s => ({
          strength: s,
          score: scoreEngine(s, classification.primary, prefer),
          availability: getAvailability(s.engine),
        }))
        .filter(e => e.availability.available && e.availability.healthy)
        .sort((a, b) => b.score - a.score);

      const alternatives: TaskRoutingAlternative[] = scored.map(e => ({
        engine: e.strength.engine,
        model: e.strength.defaultModel,
        reasoning: reasoningForCategory(classification.primary, e.strength.engine),
        estimatedCostTier: getEngineCostTier(e.strength.engine, e.strength.engine === 'claude'),
      }));

      return {
        classification,
        recommendedEngine: adaptive.engine,
        recommendedModel: strength.defaultModel,
        confidence: 'high',
        reasoning: `Thompson Sampling selected ${adaptive.engine} (confidence: ${(adaptive.confidence * 100).toFixed(1)}%)`,
        alternatives,
        costTier: getEngineCostTier(adaptive.engine, adaptive.engine === 'claude'),
        method: 'thompson',
      };
    }
  }

  // Fall through to static scoring
  const scored = ENGINE_STRENGTHS
    .map(strength => ({
      strength,
      score: scoreEngine(strength, classification.primary, prefer),
      availability: getAvailability(strength.engine),
    }))
    .filter(e => e.availability.available && e.availability.healthy)
    .sort((a, b) => b.score - a.score);

  // If no engines are available, fall back to claude as recommendation
  if (scored.length === 0) {
    return {
      classification,
      recommendedEngine: 'claude',
      recommendedModel: 'claude-opus-4-6',
      confidence: 'low',
      reasoning: 'No engines are currently available. Claude recommended as default.',
      alternatives: [],
      costTier: 'high',
      method: 'static',
    };
  }

  const best = scored[0];
  const alternatives: TaskRoutingAlternative[] = scored.slice(1).map(e => ({
    engine: e.strength.engine,
    model: e.strength.defaultModel,
    reasoning: reasoningForCategory(classification.primary, e.strength.engine),
    estimatedCostTier: getEngineCostTier(e.strength.engine, e.strength.engine === 'claude'),
  }));

  return {
    classification,
    recommendedEngine: best.strength.engine,
    recommendedModel: best.strength.defaultModel,
    confidence: confidenceFromClassification(classification),
    reasoning: reasoningForCategory(classification.primary, best.strength.engine),
    alternatives,
    costTier: getEngineCostTier(best.strength.engine, best.strength.engine === 'claude'),
    method: 'static',
  };
}
