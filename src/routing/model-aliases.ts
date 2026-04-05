import type { EngineKind } from '../types.js';

export const DEFAULT_FALLBACK_CHAIN: EngineKind[] = ['claude', 'codex', 'grok'];

export const MODEL_ALIASES: Record<EngineKind, Record<string, string>> = {
  claude: {
    opus: 'claude-opus-4-6',
    'opus-4.6': 'claude-opus-4-6',
    'claude-opus-4': 'claude-opus-4-6',
    sonnet: 'claude-sonnet-4',
    'claude-sonnet-4': 'claude-sonnet-4',
    haiku: 'claude-haiku-4',
    'claude-haiku-4': 'claude-haiku-4',
  },
  codex: {
    codex: 'gpt-5.4',
    'gpt-5.4': 'gpt-5.4',
    'gpt-5': 'gpt-5.4',
    'o4-mini': 'o4-mini',
    'codex-mini': 'codex-mini',
  },
  grok: {
    grok: 'grok-4-1-fast',
    'grok-4': 'grok-4',
    'grok-4-fast': 'grok-4-fast',
    'grok-4-1-fast': 'grok-4-1-fast',
    '4-1-fast': 'grok-4-1-fast',
    'grok-3': 'grok-3',
    'grok-mini': 'grok-3-mini',
    'grok-3-mini': 'grok-3-mini',
  },
};
