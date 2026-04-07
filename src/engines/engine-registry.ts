import { EngineError } from '../errors.js';
import type { EngineConfig, IEngine } from '../types.js';
import type { IEngineFactory } from './engine-contract.js';
import { ClaudeEngine } from './claude-engine.js';
import { CodexEngine } from './codex-engine.js';
import { GrokEngine } from './grok-engine.js';
import { OllamaEngine } from './ollama-engine.js';

const builtInFactories: IEngineFactory[] = [
  {
    engineKind: 'claude',
    displayName: 'Claude (Anthropic)',
    transport: 'subprocess',
    privacyLevel: 'cloud',
    create(config: EngineConfig): IEngine {
      return new ClaudeEngine(config);
    },
  },
  {
    engineKind: 'codex',
    displayName: 'Codex (OpenAI)',
    transport: 'subprocess',
    privacyLevel: 'cloud',
    create(config: EngineConfig): IEngine {
      return new CodexEngine(config);
    },
  },
  {
    engineKind: 'grok',
    displayName: 'Grok (xAI)',
    transport: 'http',
    privacyLevel: 'cloud',
    create(config: EngineConfig): IEngine {
      return new GrokEngine(config);
    },
  },
  {
    engineKind: 'ollama',
    displayName: 'Ollama (Local)',
    transport: 'http',
    privacyLevel: 'local',
    create(config: EngineConfig): IEngine {
      return new OllamaEngine(config);
    },
  },
];

export class EngineRegistry {
  private readonly factories = new Map<string, IEngineFactory>();

  constructor() {
    for (const factory of builtInFactories) {
      this.factories.set(factory.engineKind, factory);
    }
  }

  register(factory: IEngineFactory): void {
    if (this.factories.has(factory.engineKind)) {
      throw new EngineError(
        `Engine kind "${factory.engineKind}" is already registered.`,
        'unknown',
      );
    }
    this.factories.set(factory.engineKind, factory);
  }

  create(kind: string, config: EngineConfig): IEngine {
    const factory = this.factories.get(kind);
    if (!factory) {
      throw new EngineError(
        `Unknown engine kind "${kind}". Registered: ${[...this.factories.keys()].join(', ')}`,
        'unavailable',
      );
    }
    return factory.create(config);
  }

  has(kind: string): boolean {
    return this.factories.has(kind);
  }

  get(kind: string): IEngineFactory | undefined {
    return this.factories.get(kind);
  }

  list(): IEngineFactory[] {
    return [...this.factories.values()];
  }
}
