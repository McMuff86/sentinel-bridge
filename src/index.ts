/**
 * sentinel-bridge — OpenClaw Plugin Entry Point
 *
 * Registers tools in the sb_* namespace and exposes engines as
 * CLI backend providers.
 */

import { PLUGIN_META, DEFAULT_CONFIG } from './plugin.js';
import type { SentinelBridgeConfig } from './plugin.js';

/* ── Re-exports for library use ───────────────────────────────── */

export { PLUGIN_META, DEFAULT_CONFIG } from './plugin.js';
export type { SentinelBridgeConfig, EngineConfig } from './plugin.js';
export type { IEngine, ISession, EngineState, ModelPricing } from './types.js';

/* ── Tool definitions ─────────────────────────────────────────── */

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (params: Record<string, unknown>, ctx: PluginContext) => Promise<unknown>;
}

interface PluginContext {
  config: SentinelBridgeConfig;
  // SessionManager instance would live here at runtime
}

/**
 * Build the full tool catalogue.
 * Each tool delegates to the SessionManager; actual wiring happens
 * inside `activate()` once the OpenClaw plugin API is available.
 */
function buildTools(): ToolDef[] {
  return [
    /* ── Session lifecycle ────────────────────────────────────── */
    {
      name: 'sb_session_start',
      description:
        'Start a new engine session. Returns a session handle for follow-up messages.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Human-readable session name' },
          engine: {
            type: 'string',
            enum: ['claude', 'codex', 'grok'],
            description: 'Engine to use (default: from config)',
          },
          model: { type: 'string', description: 'Model override' },
          cwd: { type: 'string', description: 'Working directory for the session' },
        },
        required: ['name'],
      },
      handler: async (params, _ctx) => {
        return { status: 'ok', session: params.name, note: 'stub — wire to SessionManager' };
      },
    },
    {
      name: 'sb_session_send',
      description: 'Send a message to an active session and get the response.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          message: { type: 'string', description: 'Message to send' },
        },
        required: ['name', 'message'],
      },
      handler: async (params, _ctx) => {
        return { status: 'ok', response: `echo: ${params.message}` };
      },
    },
    {
      name: 'sb_session_stop',
      description: 'Stop and clean up a session.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
        },
        required: ['name'],
      },
      handler: async (params, _ctx) => {
        return { status: 'ok', stopped: params.name };
      },
    },
    {
      name: 'sb_session_list',
      description: 'List all active sessions with basic metadata.',
      parameters: { type: 'object', properties: {} },
      handler: async (_params, _ctx) => {
        return { sessions: [] };
      },
    },
    {
      name: 'sb_session_status',
      description: 'Get detailed status of a specific session.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
        },
        required: ['name'],
      },
      handler: async (params, _ctx) => {
        return { session: params.name, status: 'unknown' };
      },
    },
    {
      name: 'sb_session_overview',
      description: 'High-level overview: active sessions, total cost, engine health.',
      parameters: { type: 'object', properties: {} },
      handler: async (_params, _ctx) => {
        return { totalSessions: 0, totalCostUsd: 0, engines: {} };
      },
    },

    /* ── Engine management ────────────────────────────────────── */
    {
      name: 'sb_engine_list',
      description: 'List available engines and their configuration status.',
      parameters: { type: 'object', properties: {} },
      handler: async (_params, _ctx) => {
        return {
          engines: [
            { id: 'claude', status: 'available', auth: 'subscription' },
            { id: 'codex', status: 'available', auth: 'subscription' },
            { id: 'grok', status: 'needs-api-key', auth: 'api-key' },
          ],
        };
      },
    },
    {
      name: 'sb_engine_status',
      description: 'Check health and auth status of a specific engine.',
      parameters: {
        type: 'object',
        properties: {
          engine: { type: 'string', enum: ['claude', 'codex', 'grok'] },
        },
        required: ['engine'],
      },
      handler: async (params, _ctx) => {
        return { engine: params.engine, healthy: true };
      },
    },

    /* ── Routing & cost ───────────────────────────────────────── */
    {
      name: 'sb_model_route',
      description:
        'Resolve a model ref to the engine that will serve it, showing cost estimate.',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Model ref, e.g. "claude/opus-4.6"' },
        },
        required: ['model'],
      },
      handler: async (params, _ctx) => {
        const model = params.model as string;
        const engine = model.startsWith('grok') ? 'grok' : model.startsWith('codex') ? 'codex' : 'claude';
        return { model, engine, subscriptionCovered: engine !== 'grok' };
      },
    },
    {
      name: 'sb_cost_report',
      description: 'Aggregate cost report across all sessions, grouped by engine.',
      parameters: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'ISO date, e.g. "2026-04-04"' },
        },
      },
      handler: async (_params, _ctx) => {
        return { totalUsd: 0, byEngine: {}, subscriptionSaved: 0 };
      },
    },
    {
      name: 'sb_compact',
      description: 'Compact a session to reduce context size (engine-specific).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
        },
        required: ['name'],
      },
      handler: async (params, _ctx) => {
        return { compacted: params.name };
      },
    },
  ];
}

/* ── Plugin activation ────────────────────────────────────────── */

/**
 * Called by OpenClaw when the plugin is loaded.
 *
 * @param api - OpenClaw plugin API handle
 */
export function activate(api: {
  registerTool: (tool: { name: string; description: string; parameters: unknown; handler: (...args: unknown[]) => Promise<unknown> }) => void;
  registerCliBackend?: (id: string, config: Record<string, unknown>) => void;
  getConfig?: () => Record<string, unknown>;
}) {
  const userConfig = (api.getConfig?.() ?? {}) as Partial<SentinelBridgeConfig>;
  const config: SentinelBridgeConfig = { ...DEFAULT_CONFIG, ...userConfig };
  const ctx: PluginContext = { config };

  /* Register all tools */
  const tools = buildTools();
  for (const tool of tools) {
    api.registerTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      handler: async (...args: unknown[]) => {
        const params = (args[0] ?? {}) as Record<string, unknown>;
        return tool.handler(params, ctx);
      },
    });
  }

  /* Register CLI backends so OpenClaw can route model refs */
  if (api.registerCliBackend) {
    if (config.engines?.claude?.enabled !== false) {
      api.registerCliBackend('sentinel-claude', {
        command: config.engines?.claude?.command ?? 'claude',
        args: ['-p', '--output-format', 'stream-json', '--permission-mode', 'bypassPermissions'],
        modelArg: '--model',
        sessionArg: '--session-id',
        sessionMode: 'always',
        systemPromptArg: '--append-system-prompt',
        systemPromptWhen: 'first',
      });
    }

    if (config.engines?.codex?.enabled !== false) {
      api.registerCliBackend('sentinel-codex', {
        command: config.engines?.codex?.command ?? 'codex',
        args: ['exec', '--json', '--sandbox', 'workspace-write'],
        output: 'jsonl',
        modelArg: '--model',
        sessionMode: 'existing',
      });
    }
  }

  console.log(`[sentinel-bridge] activated — ${tools.length} tools registered`);
}
