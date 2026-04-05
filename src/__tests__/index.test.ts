import { describe, it, expect, vi } from 'vitest';
import { activate, PLUGIN_META } from '../index.js';

describe('activate', () => {
  it('registers all 12 tools', () => {
    const registered: string[] = [];
    const mockApi = {
      registerTool: vi.fn((tool: { name: string }) => {
        registered.push(tool.name);
      }),
      registerCliBackend: vi.fn(),
      getConfig: vi.fn(() => ({})),
    };

    activate(mockApi);

    expect(registered).toHaveLength(12);
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
    expect(registered).toContain('sb_session_events');
  });

  it('registers claude and codex CLI backends', () => {
    const mockApi = {
      registerTool: vi.fn(),
      registerCliBackend: vi.fn(),
      getConfig: vi.fn(() => ({})),
    };

    activate(mockApi);

    expect(mockApi.registerCliBackend).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sentinel-claude', command: 'claude' })
    );
    expect(mockApi.registerCliBackend).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sentinel-codex', command: 'codex' })
    );
  });

  it('tool execute wrappers return valid responses', async () => {
    const tools: Record<string, (id: string, params: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; details?: Record<string, unknown> }>> = {};
    const mockApi = {
      registerTool: vi.fn((tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; details?: Record<string, unknown> }> }) => {
        tools[tool.name] = tool.execute;
      }),
      registerCliBackend: vi.fn(),
      getConfig: vi.fn(() => ({})),
    };

    activate(mockApi);

    const listResult = await tools['sb_session_list']!('test', {});
    expect(JSON.parse(listResult.content[0]!.text)).toHaveProperty('sessions');

    const engineResult = await tools['sb_engine_list']!('test', {});
    expect(JSON.parse(engineResult.content[0]!.text)).toHaveProperty('engines');

    const routeResult = await tools['sb_model_route']!('test', { model: 'grok/4-1-fast' });
    expect(JSON.parse(routeResult.content[0]!.text)).toHaveProperty('engine', 'grok');
  });
});
