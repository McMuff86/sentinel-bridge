import { describe, it, expect, vi } from 'vitest';
import { activate, PLUGIN_META } from '../index.js';

describe('activate', () => {
  it('registers all 11 tools', () => {
    const registered: string[] = [];
    const mockApi = {
      registerTool: vi.fn((tool: { name: string }) => {
        registered.push(tool.name);
      }),
      registerCliBackend: vi.fn(),
      getConfig: vi.fn(() => ({})),
    };

    activate(mockApi);

    expect(registered).toHaveLength(11);
    expect(registered).toContain('sb_session_start');
    expect(registered).toContain('sb_session_send');
    expect(registered).toContain('sb_session_stop');
    expect(registered).toContain('sb_session_list');
    expect(registered).toContain('sb_session_status');
    expect(registered).toContain('sb_session_overview');
    expect(registered).toContain('sb_engine_list');
    expect(registered).toContain('sb_engine_status');
    expect(registered).toContain('sb_model_route');
    expect(registered).toContain('sb_cost_report');
    expect(registered).toContain('sb_compact');
  });

  it('registers claude and codex CLI backends', () => {
    const mockApi = {
      registerTool: vi.fn(),
      registerCliBackend: vi.fn(),
      getConfig: vi.fn(() => ({})),
    };

    activate(mockApi);

    expect(mockApi.registerCliBackend).toHaveBeenCalledWith(
      'sentinel-claude',
      expect.objectContaining({ command: 'claude' })
    );
    expect(mockApi.registerCliBackend).toHaveBeenCalledWith(
      'sentinel-codex',
      expect.objectContaining({ command: 'codex' })
    );
  });

  it('tool handlers return valid responses', async () => {
    const tools: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    const mockApi = {
      registerTool: vi.fn((tool: { name: string; handler: (...args: unknown[]) => Promise<unknown> }) => {
        tools[tool.name] = tool.handler;
      }),
      registerCliBackend: vi.fn(),
      getConfig: vi.fn(() => ({})),
    };

    activate(mockApi);

    const listResult = await tools['sb_session_list']!({});
    expect(listResult).toHaveProperty('sessions');

    const engineResult = await tools['sb_engine_list']!({});
    expect(engineResult).toHaveProperty('engines');

    const routeResult = await tools['sb_model_route']!({ model: 'grok/4-1-fast' });
    expect(routeResult).toHaveProperty('engine', 'grok');
  });
});
