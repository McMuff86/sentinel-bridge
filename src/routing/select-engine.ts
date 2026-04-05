import type { EngineKind, SessionStartOptions, SentinelBridgeConfig } from '../types.js';
import { expandFallbackChain } from './expand-fallback-chain.js';
import { getProviderCapabilities } from './provider-capabilities.js';

export function selectPrimaryEngine(
  config: SentinelBridgeConfig,
  options: SessionStartOptions,
  routedEngine?: EngineKind,
): EngineKind {
  if (options.engine) {
    return options.engine;
  }

  if (routedEngine) {
    return routedEngine;
  }

  const chain = expandFallbackChain(
    config,
    config.defaultEngine ?? 'claude',
  );

  if (options.resumeSessionId) {
    const resumeCapable = chain.find((engine) =>
      getProviderCapabilities(engine).supportsResume,
    );
    if (resumeCapable) {
      return resumeCapable;
    }
  }

  if (options.cwd) {
    const cwdCapable = chain.find((engine) =>
      getProviderCapabilities(engine).supportsWorkingDirectoryState,
    );
    if (cwdCapable) {
      return cwdCapable;
    }
  }

  return config.defaultEngine ?? 'claude';
}
