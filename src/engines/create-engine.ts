import { EngineRegistry } from './engine-registry.js';
import type { EngineConfig, EngineKind, IEngine } from '../types.js';

const defaultRegistry = new EngineRegistry();

export function createEngine(engine: EngineKind, config: EngineConfig): IEngine {
  return defaultRegistry.create(engine, config);
}

export { defaultRegistry };
