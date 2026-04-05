import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { EngineKind, SessionInfo } from '../types.js';

type PersistedSessionRecord = {
  id: string;
  name: string;
  engine: EngineKind;
  model: string;
  status: string;
  createdAt: string;
  costUsd: number;
  tokenCount: {
    input: number;
    output: number;
    cachedInput: number;
    total: number;
  };
  cwd: string | null;
  engineState: string;
  engineSessionId: string | null;
  lastTouchedAt: string;
  lastError?: string;
  routingTrace?: SessionInfo['routingTrace'];
  activity?: {
    phase: string;
    lastAction: string;
    updatedAt: string;
    lastPromptPreview: string | null;
    lastResponsePreview: string | null;
    isRehydrated: boolean;
  };
};

type SessionStoreData = {
  version: 1;
  sessions: Record<string, PersistedSessionRecord>;
};

function getDefaultStorePath(): string {
  const home = process?.env?.HOME ?? '/tmp';
  return join(home, '.openclaw', 'extensions', 'sentinel-bridge', 'state', 'sessions.json');
}

export class SessionStore {
  private readonly path: string;

  constructor(path = getDefaultStorePath()) {
    this.path = path;
  }

  load(): SessionStoreData {
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as SessionStoreData;
      if (!parsed || parsed.version !== 1 || typeof parsed.sessions !== 'object') {
        return { version: 1, sessions: {} };
      }
      return parsed;
    } catch {
      return { version: 1, sessions: {} };
    }
  }

  save(data: SessionStoreData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  upsert(session: SessionInfo): void {
    const data = this.load();
    data.sessions[session.name] = {
      id: session.id,
      name: session.name,
      engine: session.engine,
      model: session.model,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      costUsd: session.costUsd,
      tokenCount: { ...session.tokenCount },
      cwd: session.cwd,
      engineState: session.engineState,
      engineSessionId: session.engineSessionId,
      lastTouchedAt: session.lastTouchedAt.toISOString(),
      lastError: session.lastError,
      routingTrace: session.routingTrace,
      activity: {
        phase: session.activity.phase,
        lastAction: session.activity.lastAction,
        updatedAt: session.activity.updatedAt.toISOString(),
        lastPromptPreview: session.activity.lastPromptPreview,
        lastResponsePreview: session.activity.lastResponsePreview,
        isRehydrated: session.activity.isRehydrated,
      },
    };
    this.save(data);
  }

  get(name: string): SessionInfo | undefined {
    const item = this.load().sessions[name];
    if (!item) return undefined;
    return toSessionInfoFromPersisted(item);
  }

  delete(name: string): void {
    const data = this.load();
    if (!(name in data.sessions)) return;
    delete data.sessions[name];
    this.save(data);
  }

  list(): SessionInfo[] {
    return Object.values(this.load().sessions).map(toSessionInfoFromPersisted);
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}

function toSessionInfoFromPersisted(item: PersistedSessionRecord): SessionInfo {
  const lastTouchedAt = new Date(item.lastTouchedAt);

  return {
    id: item.id,
    name: item.name,
    engine: item.engine,
    model: item.model,
    status: item.status as SessionInfo['status'],
    createdAt: new Date(item.createdAt),
    costUsd: item.costUsd,
    tokenCount: { ...item.tokenCount },
    cwd: item.cwd,
    engineState: item.engineState as SessionInfo['engineState'],
    engineSessionId: item.engineSessionId,
    lastTouchedAt,
    lastError: item.lastError,
    routingTrace: item.routingTrace,
    activity: item.activity
      ? {
          phase: item.activity.phase as SessionInfo['activity']['phase'],
          lastAction: item.activity.lastAction as SessionInfo['activity']['lastAction'],
          updatedAt: new Date(item.activity.updatedAt),
          lastPromptPreview: item.activity.lastPromptPreview,
          lastResponsePreview: item.activity.lastResponsePreview,
          isRehydrated: item.activity.isRehydrated,
        }
      : {
          phase: 'stopped',
          lastAction: 'stop',
          updatedAt: lastTouchedAt,
          lastPromptPreview: null,
          lastResponsePreview: null,
          isRehydrated: false,
        },
  };
}
