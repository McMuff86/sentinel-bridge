import { EngineRegistry } from './engine-registry.js';
import type { EngineConfig, EngineKind, IEngine } from '../types.js';

const registry = new EngineRegistry();

export function createEngine(engine: EngineKind, config: EngineConfig): IEngine {
  return registry.create(engine, config);
}
