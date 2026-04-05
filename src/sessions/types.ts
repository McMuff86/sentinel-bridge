import type { EngineConfig, IEngine, ISession } from '../types.js';

export interface SessionRecord {
  engineInstance: IEngine;
  session: ISession;
  config: EngineConfig;
  lastTouchedAt: number;
}
