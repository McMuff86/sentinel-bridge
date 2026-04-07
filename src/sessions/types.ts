import type {
  EngineConfig,
  IEngine,
  ISession,
  RoutingTrace,
  SessionAction,
  SessionPhase,
} from '../types.js';

export interface SessionRecord {
  engineInstance: IEngine;
  session: ISession;
  config: EngineConfig;
  lastTouchedAt: number;
  routingTrace?: RoutingTrace;
  phase: SessionPhase;
  lastAction: SessionAction;
  updatedAt: number;
  lastPromptPreview: string | null;
  lastResponsePreview: string | null;
  isRehydrated: boolean;
  turnCount: number;
  role?: string;
}
