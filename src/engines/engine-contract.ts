import type { EngineConfig, IEngine } from '../types.js';

export interface IEngineFactory {
  readonly engineKind: string;
  readonly displayName: string;
  readonly transport: 'subprocess' | 'http';
  readonly privacyLevel: 'cloud' | 'local';
  create(config: EngineConfig): IEngine;
  healthCheck?(config: Partial<EngineConfig>): Promise<boolean>;
}
