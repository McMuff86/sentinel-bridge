import type { EngineKind } from '../types.js';

export interface ProviderCapabilities {
  engine: EngineKind;
  authMode: 'cli' | 'http-api' | 'mixed';
  supportsResume: boolean;
  supportsPersistentProcess: boolean;
  supportsStreaming: boolean;
  supportsWorkingDirectoryState: boolean;
  transport: 'subprocess' | 'http';
  codeStrength: 'low' | 'medium' | 'high';
  reasoningStrength: 'low' | 'medium' | 'high';
  speedTier: 'slow' | 'medium' | 'fast';
  privacyLevel: 'cloud' | 'local';
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
    codeStrength: 'high',
    reasoningStrength: 'high',
    speedTier: 'medium',
    privacyLevel: 'cloud',
  },
  codex: {
    engine: 'codex',
    authMode: 'mixed',
    supportsResume: false,
    supportsPersistentProcess: false,
    supportsStreaming: false,
    supportsWorkingDirectoryState: true,
    transport: 'subprocess',
    codeStrength: 'high',
    reasoningStrength: 'high',
    speedTier: 'medium',
    privacyLevel: 'cloud',
  },
  grok: {
    engine: 'grok',
    authMode: 'http-api',
    supportsResume: false,
    supportsPersistentProcess: false,
    supportsStreaming: true,
    supportsWorkingDirectoryState: false,
    transport: 'http',
    codeStrength: 'medium',
    reasoningStrength: 'medium',
    speedTier: 'fast',
    privacyLevel: 'cloud',
  },
  ollama: {
    engine: 'ollama',
    authMode: 'http-api',
    supportsResume: false,
    supportsPersistentProcess: false,
    supportsStreaming: true,
    supportsWorkingDirectoryState: false,
    transport: 'http',
    codeStrength: 'medium',
    reasoningStrength: 'low',
    speedTier: 'fast',
    privacyLevel: 'local',
  },
};

export function getProviderCapabilities(engine: EngineKind): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[engine];
}
