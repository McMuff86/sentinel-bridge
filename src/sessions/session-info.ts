import type {
  EngineCostBreakdown,
  EngineKind,
  ISession,
  SessionInfo,
} from '../types.js';
import { emptyTokenUsage } from '../engines/shared.js';
import type { SessionRecord } from './types.js';

export function cloneSession(session: ISession): ISession {
  return {
    ...session,
    createdAt: new Date(session.createdAt),
    tokenCount: { ...session.tokenCount },
  };
}

export function syncSession(record: SessionRecord): void {
  const engineStatus = record.engineInstance.status();

  record.session.model = engineStatus.model || record.session.model;
  record.config.model = record.session.model;
  record.session.costUsd = engineStatus.usage.costUsd;
  record.session.tokenCount = { ...engineStatus.usage.tokenCount };

  if (record.session.status === 'expired') {
    return;
  }

  if (engineStatus.state === 'error') {
    record.session.status = 'error';
    return;
  }

  if (engineStatus.state === 'stopped') {
    record.session.status = 'stopped';
    return;
  }

  record.session.status = 'active';
}

export function toSessionInfo(
  name: string,
  record: SessionRecord,
): SessionInfo {
  const session = cloneSession(record.session);
  const status = record.engineInstance.status();

  return {
    ...session,
    name,
    cwd: record.config.cwd ?? null,
    engineState: status.state,
    engineSessionId: status.sessionId,
    lastTouchedAt: new Date(record.lastTouchedAt),
    lastError: status.usage.lastError,
    routingTrace: record.routingTrace,
    activity: {
      phase: record.phase,
      lastAction: record.lastAction,
      updatedAt: new Date(record.updatedAt),
      lastPromptPreview: record.lastPromptPreview,
      lastResponsePreview: record.lastResponsePreview,
      isRehydrated: record.isRehydrated,
    },
    turnCount: record.turnCount,
    role: record.role,
  };
}

export function createEmptyBreakdown(): EngineCostBreakdown {
  return {
    sessionCount: 0,
    costUsd: 0,
    tokenCount: emptyTokenUsage(),
  };
}

export function createEmptyBreakdownMap(): Record<EngineKind, EngineCostBreakdown> {
  return {
    claude: createEmptyBreakdown(),
    codex: createEmptyBreakdown(),
    grok: createEmptyBreakdown(),
    ollama: createEmptyBreakdown(),
  };
}
