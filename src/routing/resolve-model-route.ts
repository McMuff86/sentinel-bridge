import type {
  EngineConfig,
  EngineKind,
  ModelRoute,
  SentinelBridgeConfig,
} from '../types.js';
import { MODEL_ALIASES } from './model-aliases.js';

type ParsedModelReference = {
  engine?: EngineKind;
  model: string;
};

export function resolveModelRoute(
  config: SentinelBridgeConfig,
  getEngineDefaults: (engine: EngineKind) => Partial<EngineConfig>,
  getFallbackModel: (engine: EngineKind) => string,
  model: string,
  preferredEngine?: EngineKind,
): ModelRoute {
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    return resolveDefaultRoute(
      config,
      getEngineDefaults,
      getFallbackModel,
      preferredEngine,
    );
  }

  const parsed = parseModelReference(trimmedModel);
  if (preferredEngine && parsed.engine && parsed.engine !== preferredEngine) {
    throw new Error(
      `Model "${trimmedModel}" does not match requested engine "${preferredEngine}".`,
    );
  }

  const detectedEngine = parsed.engine ?? inferEngineFromModel(parsed.model);
  const engine = preferredEngine ?? detectedEngine ?? config.defaultEngine ?? 'claude';
  const conflictingEngine =
    preferredEngine && !parsed.engine
      ? inferEngineFromModel(parsed.model)
      : undefined;

  if (
    preferredEngine &&
    conflictingEngine &&
    conflictingEngine !== preferredEngine &&
    !isKnownAliasForEngine(preferredEngine, parsed.model)
  ) {
    throw new Error(
      `Model "${trimmedModel}" does not match requested engine "${preferredEngine}".`,
    );
  }

  const resolvedModel = resolveModelAlias(engine, parsed.model);
  const source = resolvedModel === parsed.model ? 'explicit' : 'alias';

  return {
    model: resolvedModel,
    engine,
    subscriptionCovered: engine === 'claude',
    source,
  };
}

export function resolveDefaultRoute(
  config: SentinelBridgeConfig,
  getEngineDefaults: (engine: EngineKind) => Partial<EngineConfig>,
  getFallbackModel: (engine: EngineKind) => string,
  preferredEngine?: EngineKind,
): ModelRoute {
  const defaultModel = config.defaultModel?.trim();
  if (defaultModel) {
    const parsedDefault = parseModelReference(defaultModel);
    const defaultEngine =
      parsedDefault.engine ?? inferEngineFromModel(parsedDefault.model);

    if (!preferredEngine || !defaultEngine || defaultEngine === preferredEngine) {
      const route = resolveModelRoute(
        config,
        getEngineDefaults,
        getFallbackModel,
        defaultModel,
        preferredEngine,
      );
      return {
        ...route,
        source: 'default',
      };
    }
  }

  const engine = preferredEngine ?? config.defaultEngine ?? 'claude';
  const defaults = getEngineDefaults(engine);

  return {
    engine,
    model: defaults.model ?? getFallbackModel(engine),
    subscriptionCovered: engine === 'claude',
    source: 'default',
  };
}

function parseModelReference(model: string): ParsedModelReference {
  const [rawPrefix, ...rest] = model.split('/');
  if (rest.length === 0) {
    return { model };
  }

  const engine = parseEngineKind(rawPrefix);
  return {
    engine,
    model: rest.join('/'),
  };
}

function parseEngineKind(value: string): EngineKind | undefined {
  switch (value.trim().toLowerCase()) {
    case 'claude':
      return 'claude';
    case 'codex':
    case 'openai':
      return 'codex';
    case 'grok':
    case 'xai':
      return 'grok';
    case 'ollama':
      return 'ollama';
    default:
      return undefined;
  }
}

function inferEngineFromModel(model: string): EngineKind | undefined {
  const normalizedModel = model.trim().toLowerCase();

  if (!normalizedModel) {
    return undefined;
  }

  if (
    normalizedModel.startsWith('claude-') ||
    normalizedModel === 'opus' ||
    normalizedModel === 'sonnet' ||
    normalizedModel === 'haiku' ||
    normalizedModel === 'opus-4.6'
  ) {
    return 'claude';
  }

  if (
    normalizedModel.startsWith('grok-') ||
    normalizedModel === 'grok' ||
    normalizedModel === 'grok-mini' ||
    normalizedModel === '4-1-fast'
  ) {
    return 'grok';
  }

  if (
    normalizedModel.startsWith('gpt-') ||
    normalizedModel.startsWith('o4-') ||
    normalizedModel.startsWith('codex-') ||
    normalizedModel === 'codex'
  ) {
    return 'codex';
  }

  if (
    normalizedModel.startsWith('llama') ||
    normalizedModel.startsWith('mistral') ||
    normalizedModel.startsWith('codellama') ||
    normalizedModel.startsWith('deepseek') ||
    normalizedModel.startsWith('qwen') ||
    normalizedModel.startsWith('gemma') ||
    normalizedModel.startsWith('phi') ||
    normalizedModel.startsWith('moondream')
  ) {
    return 'ollama';
  }

  return undefined;
}

function resolveModelAlias(engine: EngineKind, model: string): string {
  const normalizedModel = model.trim().toLowerCase();
  const alias = MODEL_ALIASES[engine][normalizedModel];

  return alias ?? model.trim();
}

function isKnownAliasForEngine(engine: EngineKind, model: string): boolean {
  const normalizedModel = model.trim().toLowerCase();

  return (
    Boolean(MODEL_ALIASES[engine][normalizedModel]) ||
    inferEngineFromModel(normalizedModel) === engine
  );
}
