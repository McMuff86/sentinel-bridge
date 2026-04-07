import { join } from 'node:path';

/**
 * Returns the root state directory for sentinel-bridge persistence.
 *
 * Resolution order:
 *   1. SENTINEL_BRIDGE_STATE_DIR environment variable (allows OpenClaw or other hosts to override)
 *   2. ~/.sentinel-bridge/state (standalone default)
 */
export function getStateDir(): string {
  const home = process?.env?.HOME ?? '/tmp';
  return process?.env?.SENTINEL_BRIDGE_STATE_DIR ?? join(home, '.sentinel-bridge', 'state');
}
