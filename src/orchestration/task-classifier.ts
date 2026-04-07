export type TaskCategory =
  | 'code_generation'
  | 'code_review'
  | 'reasoning'
  | 'fast_task'
  | 'creative'
  | 'local_private'
  | 'general';

export interface TaskClassification {
  primary: TaskCategory;
  secondary?: TaskCategory;
  signals: string[];
  complexity: 'simple' | 'moderate' | 'complex';
}

interface CategorySignals {
  category: TaskCategory;
  keywords: string[];
  patterns: RegExp[];
  weight: number;
}

const CATEGORY_SIGNALS: CategorySignals[] = [
  {
    category: 'code_generation',
    keywords: [
      'implement', 'write code', 'create function', 'add feature', 'build',
      'generate', 'scaffold', 'coding', 'program', 'develop',
      'fix bug', 'fix the', 'refactor', 'rewrite', 'migrate',
    ],
    patterns: [
      /\.(ts|js|py|go|rs|java|cpp|c|rb|swift|kt)(\s|$|[,.])/i,
      /function\s+\w+/i,
      /class\s+\w+/i,
      /import\s+/i,
      /```\w+/,
    ],
    weight: 2,
  },
  {
    category: 'code_review',
    keywords: [
      'review', 'audit', 'check code', 'find bugs', 'security review',
      'code quality', 'lint', 'static analysis', 'vulnerability',
      'look at this code', 'what\'s wrong',
    ],
    patterns: [
      /review\s+(this|the|my)\s+(code|pr|pull|commit)/i,
      /is\s+this\s+(code|implementation)\s+(correct|safe|good)/i,
    ],
    weight: 2,
  },
  {
    category: 'reasoning',
    keywords: [
      'analyze', 'design', 'architect', 'trade-off', 'tradeoff',
      'evaluate', 'compare', 'explain why', 'reason about',
      'think through', 'plan', 'strategy', 'decision',
      'pros and cons', 'advantages', 'disadvantages',
    ],
    patterns: [
      /should\s+(we|i)\s+(use|choose|pick|go\s+with)/i,
      /what\s+(are\s+the|is\s+the\s+best)\s+(approach|way|strategy)/i,
      /how\s+should\s+(we|i)/i,
    ],
    weight: 1.5,
  },
  {
    category: 'fast_task',
    keywords: [
      'summarize', 'translate', 'format', 'quick', 'simple',
      'convert', 'list', 'extract', 'parse', 'count',
      'rename', 'short answer', 'briefly',
    ],
    patterns: [
      /^(what|how|when|where|who)\s+is\b/i,
      /^(give|show|tell)\s+me\b/i,
      /in\s+(one|a)\s+(sentence|word|line)/i,
    ],
    weight: 1,
  },
  {
    category: 'creative',
    keywords: [
      'creative', 'brainstorm', 'imagine', 'story', 'poem',
      'narrative', 'write a', 'compose', 'draft',
      'name suggestions', 'tagline', 'slogan',
    ],
    patterns: [
      /write\s+(a|an|me)\s+(story|poem|essay|blog|article)/i,
    ],
    weight: 1,
  },
  {
    category: 'local_private',
    keywords: [
      'local', 'private', 'offline', 'sensitive', 'no cloud',
      'on-premise', 'air-gapped', 'confidential', 'secret',
      'pii', 'personal data', 'hipaa', 'gdpr',
    ],
    patterns: [
      /keep\s+(it\s+)?(local|private|offline)/i,
      /don't\s+send\s+(to|outside)/i,
    ],
    weight: 3,
  },
];

function scoreCategory(
  text: string,
  lower: string,
  signals: CategorySignals,
): { score: number; matched: string[] } {
  const matched: string[] = [];
  let score = 0;

  for (const keyword of signals.keywords) {
    if (lower.includes(keyword.toLowerCase())) {
      score += signals.weight;
      matched.push(keyword);
    }
  }

  for (const pattern of signals.patterns) {
    if (pattern.test(text)) {
      score += signals.weight;
      matched.push(pattern.source);
    }
  }

  return { score, matched };
}

function estimateComplexity(text: string): 'simple' | 'moderate' | 'complex' {
  const words = text.split(/\s+/).length;
  if (words < 20) return 'simple';
  if (words < 80) return 'moderate';
  return 'complex';
}

export function classifyTask(description: string): TaskClassification {
  const lower = description.toLowerCase();
  const results = CATEGORY_SIGNALS.map(signals => ({
    category: signals.category,
    ...scoreCategory(description, lower, signals),
  }));

  results.sort((a, b) => b.score - a.score);

  const primary = results[0].score > 0 ? results[0].category : 'general';
  const secondary =
    results[1] && results[1].score > 0 ? results[1].category : undefined;

  const allMatched = results.flatMap(r => r.matched);

  return {
    primary,
    secondary,
    signals: allMatched,
    complexity: estimateComplexity(description),
  };
}
