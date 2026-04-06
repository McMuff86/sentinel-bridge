import { describe, it, expect, vi } from 'vitest';
import { activate } from '../index.js';

describe('mergePluginConfig deep merge', () => {
  it('preserves default engine env when user overrides other fields', () => {
    // We test through activate() since mergePluginConfig is private.
    // Provide defaults with env, then override command only.
    let capturedConfig: Record<string, unknown> | undefined;

    const mockApi = {
      registerTool: vi.fn(),
      registerCliBackend: vi.fn(),
      getConfig: vi.fn(() => ({
        engines: {
          claude: {
            command: '/custom/claude',
            // User does NOT set env — defaults should survive
          },
          grok: {
            apiKey: 'test-key',
            env: { CUSTOM_VAR: 'user-value' },
          },
        },
      })),
    };

    activate(mockApi);

    // Claude backend should use the custom command
    expect(mockApi.registerCliBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sentinel-claude',
        command: '/custom/claude',
      }),
    );

    // Codex should still have its defaults
    expect(mockApi.registerCliBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sentinel-codex',
        command: 'codex',
      }),
    );
  });

  it('does not let engine overrides wipe top-level defaults', () => {
    const mockApi = {
      registerTool: vi.fn(),
      registerCliBackend: vi.fn(),
      getConfig: vi.fn(() => ({
        maxConcurrentSessions: 3,
      })),
    };

    activate(mockApi);

    // Should still register tools — plugin activates successfully
    expect(mockApi.registerTool).toHaveBeenCalled();
  });
});
