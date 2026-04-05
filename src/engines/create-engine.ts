import { ClaudeEngine } from './claude-engine.js';
import { CodexEngine } from './codex-engine.js';
import { GrokEngine } from './grok-engine.js';
import type { EngineConfig, EngineKind, IEngine } from '../types.js';

export function createEngine(
  engine: EngineKind,
  config: EngineConfig,
): IEngine {
  switch (engine) {
    case 'claude':
      return new ClaudeEngine(config);
    case 'codex':
      return new CodexEngine(config);
    case 'grok':
      return new GrokEngine(config);
    default: {
      const exhaustiveCheck: never = engine;
      throw new Error(`Unsupported engine: ${exhaustiveCheck}`);
    }
  }
}
