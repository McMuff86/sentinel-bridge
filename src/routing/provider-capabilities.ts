import type { EngineKind } from '../types.js';

export interface ProviderCapabilities {
  engine: EngineKind;
  authMode: 'cli' | 'http-api' | 'mixed';
  supportsResume: boolean;
  supportsPersistentProcess: boolean;
  supportsStreaming: boolean;
  supportsWorkingDirectoryState: boolean;
  transport: 'subprocess' | 'http';
}

export const PROVIDER_CAPABILITIES: Record<EngineKind, ProviderCapabilities> = {
  claude: {
    engine: 'claude',
    authMode: 'cli',
    supportsResume: true,
    supportsPersistentProcess: true,
    supportsStreaming: true,
    supportsWorkingDirectoryState: true,
    transport: 'subprocess',
  },
  codex: {
    engine: 'codex',
    authMode: 'mixed',
    supportsResume: false,
    supportsPersistentProcess: false,
    supportsStreaming: false,
    supportsWorkingDirectoryState: true,
    transport: 'subprocess',
  },
  grok: {
    engine: 'grok',
    authMode: 'http-api',
    supportsResume: false,
    supportsPersistentProcess: false,
    supportsStreaming: true,
    supportsWorkingDirectoryState: false,
    transport: 'http',
  },
  ollama: {
    engine: 'ollama',
    authMode: 'http-api',
    supportsResume: false,
    supportsPersistentProcess: false,
    supportsStreaming: false,
    supportsWorkingDirectoryState: false,
    transport: 'http',
  },
};

export function getProviderCapabilities(engine: EngineKind): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[engine];
}
