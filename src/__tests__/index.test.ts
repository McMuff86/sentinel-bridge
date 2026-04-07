import { describe, it, expect, vi } from 'vitest';
import { activate, PLUGIN_META } from '../index.js';

describe('activate', () => {
  it('registers all tools', () => {
    const registered: string[] = [];
    const mockApi = {
      registerTool: vi.fn((tool: { name: string }) => {
        registered.push(tool.name);
      }),
      registerCliBackend: vi.fn(),
      getConfig: vi.fn(() => ({})),
    };

    activate(mockApi);

    expect(registered).toHaveLength(32);
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
    expect(registered).toContain('sb_session_cancel');
    expect(registered).toContain('sb_context_set');
    expect(registered).toContain('sb_context_get');
    expect(registered).toContain('sb_context_list');
    expect(registered).toContain('sb_context_clear');
    expect(registered).toContain('sb_role_list');
    expect(registered).toContain('sb_role_get');
    expect(registered).toContain('sb_role_register');
    expect(registered).toContain('sb_session_relay');
    expect(registered).toContain('sb_session_broadcast');
    expect(registered).toContain('sb_workflow_start');
    expect(registered).toContain('sb_workflow_status');
    expect(registered).toContain('sb_workflow_resume');
    expect(registered).toContain('sb_workflow_cancel');
    expect(registered).toContain('sb_workflow_list');
    expect(registered).toContain('sb_workflow_template');
    expect(registered).toContain('sb_route_task');
    expect(registered).toContain('sb_health_check');
    expect(registered).toContain('sb_circuit_status');
    expect(registered).toContain('sb_circuit_reset');
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

  it('deep-merges per-engine config so defaults survive partial overrides', () => {
    const mockApi = {
      registerTool: vi.fn(),
      registerCliBackend: vi.fn(),
      getConfig: vi.fn(() => ({
        engines: {
          claude: {
            command: '/custom/claude',
          },
        },
      })),
    };

    activate(mockApi);

    expect(mockApi.registerCliBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sentinel-claude',
        command: '/custom/claude',
      })
    );
    expect(mockApi.registerCliBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sentinel-codex',
        command: 'codex',
      })
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
