import type {
  EngineConfig,
  IEngine,
  ISession,
  RoutingTrace,
} from '../types.js';

export interface SessionRecord {
  engineInstance: IEngine;
  session: ISession;
  config: EngineConfig;
  lastTouchedAt: number;
  routingTrace?: RoutingTrace;
}
