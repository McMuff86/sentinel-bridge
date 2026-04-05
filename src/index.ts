/**
 * sentinel-bridge — OpenClaw Plugin Entry Point
 *
 * Registers tools in the sb_* namespace and exposes engines as
 * CLI backend providers.
 */

import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, resolve as resolvePath } from 'node:path';

import { DEFAULT_CONFIG, PLUGIN_META } from './plugin.js';
import type {
  EngineConfig as PluginEngineConfig,
  SentinelBridgeConfig,
} from './plugin.js';
import { SessionManager } from './session-manager.js';

/* ── Re-exports for library use ───────────────────────────────── */

export { PLUGIN_META, DEFAULT_CONFIG } from './plugin.js';
export type { SentinelBridgeConfig, EngineConfig } from './plugin.js';
export type {
  CostReport,
  EngineKind,
  EngineState,
  IEngine,
  ISession,
  ModelPricing,
  ModelRoute,
  SendMessageResult,
  SessionAction,
  SessionActivity,
  SessionInfo,
  SessionOverview,
  SessionPhase,
  TurnUsage,
} from './types.js';

type EngineKind = 'claude' | 'codex' | 'grok';

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (
    params: Record<string, unknown>,
    ctx: PluginContext,
  ) => Promise<unknown>;
}

interface PluginContext {
  config: SentinelBridgeConfig;
  manager: SessionManager;
}

interface ToolHandlerResponse {
  ok: boolean;
  [key: string]: unknown;
}

interface EngineDescriptor {
  id: EngineKind;
  enabled: boolean;
  available: boolean;
  healthy: boolean;
  binary: string | null;
  authMethod: string;
  authValid: boolean;
  model: string | null;
  note?: string;
}

interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface PluginApi {
  registerTool: (tool: {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    execute: (id: string, params: Record<string, unknown>) => Promise<{
      content: Array<{ type: 'text'; text: string }>;
      details?: Record<string, unknown>;
    }>;
  }) => void;
  registerCliBackend?: (backend: Record<string, unknown>) => void;
  getConfig?: () => Record<string, unknown>;
  logger?: PluginLogger;
}

const ENGINE_KINDS: EngineKind[] = ['claude', 'codex', 'grok'];
const DEFAULT_ENGINE_COMMANDS: Record<EngineKind, string | undefined> = {
  claude: 'claude',
  codex: 'codex',
  grok: undefined,
};

/**
 * Build the full tool catalogue.
 * Each tool delegates to the SessionManager and uses local health/config
 * helpers where direct engine probing is needed.
 */
function buildTools(): ToolDef[] {
  return [
    {
      name: 'sb_session_start',
      description:
        'Start a new engine session. Returns a session handle for follow-up messages. ' +
        'If the primary engine fails to start, the plugin retries along config.defaultFallbackChain ' +
        '(default: claude → codex → grok); use an empty chain to disable.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Human-readable session name' },
          engine: {
            type: 'string',
            enum: ENGINE_KINDS,
            description: 'Engine to use (default: from config)',
          },
          model: { type: 'string', description: 'Model override' },
          cwd: { type: 'string', description: 'Working directory for the session' },
          resumeSessionId: {
            type: 'string',
            description: 'Resume an existing engine session when supported',
          },
        },
        required: ['name'],
      },
      handler: async (params, ctx) => {
        const session = await ctx.manager.startSession({
          name: readRequiredString(params, 'name'),
          engine: readEngineKind(params, 'engine'),
          model: readOptionalString(params, 'model'),
          cwd: readOptionalString(params, 'cwd'),
          resumeSessionId: readOptionalString(params, 'resumeSessionId'),
        });

        return {
          ok: true,
          session: serializeSession(session),
        } satisfies ToolHandlerResponse;
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
      handler: async (params, ctx) => {
        const result = await ctx.manager.sendMessage(
          readRequiredString(params, 'name'),
          readRequiredString(params, 'message'),
        );

        return serializeTurnResult(result);
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
      handler: async (params, ctx) => {
        const name = readRequiredString(params, 'name');
        await ctx.manager.stopSession(name);
        const session = ctx.manager.getSessionStatus(name);

        return {
          ok: true,
          name,
          status: session?.status ?? 'stopped',
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_session_list',
      description: 'List all active sessions with basic metadata.',
      parameters: { type: 'object', properties: {} },
      handler: async (_params, ctx) => {
        return {
          ok: true,
          sessions: ctx.manager.listSessions().map(serializeSession),
        } satisfies ToolHandlerResponse;
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
      handler: async (params, ctx) => {
        const name = readRequiredString(params, 'name');
        const session = ctx.manager.getSessionStatus(name);
        if (!session) {
          throw new Error(`Session "${name}" not found.`);
        }

        return {
          ok: true,
          session: serializeSession(session),
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_session_overview',
      description: 'High-level overview: active sessions, total cost, engine health.',
      parameters: { type: 'object', properties: {} },
      handler: async (_params, ctx) => {
        const overview = ctx.manager.getOverview();
        const engines = Object.fromEntries(
          ENGINE_KINDS.map((engine) => [
            engine,
            getEngineDescriptor(engine, ctx.config),
          ]),
        );

        return {
          ok: true,
          overview: serializeOverview(overview),
          engines,
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_engine_list',
      description: 'List available engines and their configuration status.',
      parameters: { type: 'object', properties: {} },
      handler: async (_params, ctx) => {
        return {
          ok: true,
          engines: ENGINE_KINDS.map((engine) =>
            getEngineDescriptor(engine, ctx.config),
          ),
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_engine_status',
      description: 'Check health and auth status of a specific engine.',
      parameters: {
        type: 'object',
        properties: {
          engine: { type: 'string', enum: ENGINE_KINDS },
        },
        required: ['engine'],
      },
      handler: async (params, ctx) => {
        const engine = readEngineKind(params, 'engine');
        if (!engine) {
          throw new Error('Engine is required.');
        }

        return {
          ok: true,
          engine: getEngineDescriptor(engine, ctx.config),
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_model_route',
      description:
        'Resolve a model ref to the engine that will serve it, showing cost estimate.',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Model ref, e.g. "claude/opus-4.6"' },
          engine: {
            type: 'string',
            enum: ENGINE_KINDS,
            description: 'Optional preferred engine when the model is ambiguous',
          },
        },
        required: ['model'],
      },
      handler: async (params, ctx) => {
        const route = ctx.manager.resolveModelRoute(
          readRequiredString(params, 'model'),
          readEngineKind(params, 'engine'),
        );
        const engineStatus = getEngineDescriptor(route.engine, ctx.config);

        return {
          ok: true,
          ...route,
          available: engineStatus.available,
          healthy: engineStatus.healthy,
        } satisfies ToolHandlerResponse;
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
      handler: async (params, ctx) => {
        return {
          ok: true,
          report: serializeCostReport(
            ctx.manager.getCostReport(readOptionalString(params, 'since')),
          ),
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_compact',
      description: 'Compact a session to reduce context size (engine-specific).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          summary: {
            type: 'string',
            description: 'Optional compaction guidance or custom summary target',
          },
        },
        required: ['name'],
      },
      handler: async (params, ctx) => {
        const result = await ctx.manager.compactSession(
          readRequiredString(params, 'name'),
          readOptionalString(params, 'summary'),
        );

        return {
          ...serializeTurnResult(result),
          compacted: result.name,
        } satisfies ToolHandlerResponse;
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
export function activate(api: PluginApi): void {
  const userConfig = (api.getConfig?.() ?? {}) as Partial<SentinelBridgeConfig>;
  const config: SentinelBridgeConfig = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    engines: {
      ...DEFAULT_CONFIG.engines,
      ...userConfig.engines,
    },
  };
  const ctx: PluginContext = {
    config,
    manager: new SessionManager(toSessionManagerConfig(config)),
  };

  const tools = buildTools();
  for (const tool of tools) {
    api.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: async (_id: string, params: Record<string, unknown>) => {
        const result = await tool.handler(params ?? {}, ctx);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
          details:
            result && typeof result === 'object'
              ? (result as Record<string, unknown>)
              : undefined,
        };
      },
    });
  }

  if (api.registerCliBackend) {
    if (config.engines?.claude?.enabled !== false) {
      api.registerCliBackend({
        id: 'sentinel-claude',
        command: config.engines?.claude?.command ?? 'claude',
        args: [
          '-p',
          '--verbose',
          '--output-format',
          'stream-json',
          '--permission-mode',
          'bypassPermissions',
        ],
        modelArg: '--model',
        sessionArg: '--session-id',
        sessionMode: 'always',
        systemPromptArg: '--append-system-prompt',
        systemPromptWhen: 'first',
      });
    }

    if (config.engines?.codex?.enabled !== false) {
      api.registerCliBackend({
        id: 'sentinel-codex',
        command: config.engines?.codex?.command ?? 'codex',
        args: ['exec', '--json', '--sandbox', 'workspace-write'],
        output: 'jsonl',
        modelArg: '--model',
        sessionMode: 'existing',
      });
    }
  }

  api.logger?.info(
    `[sentinel-bridge] activated with ${tools.length} registered tools.`,
  );
}

function readRequiredString(
  params: Record<string, unknown>,
  key: string,
): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Parameter "${key}" must be a non-empty string.`);
  }

  return value.trim();
}

function readOptionalString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue ? trimmedValue : undefined;
}

function readEngineKind(
  params: Record<string, unknown>,
  key: string,
): EngineKind | undefined {
  const value = readOptionalString(params, key);
  if (!value) {
    return undefined;
  }

  if (ENGINE_KINDS.includes(value as EngineKind)) {
    return value as EngineKind;
  }

  throw new Error(
    `Parameter "${key}" must be one of: ${ENGINE_KINDS.join(', ')}.`,
  );
}

function serializeTurnResult(result: {
  name: string;
  output: string;
  session: ReturnType<SessionManager['getSessionStatus']> extends infer T
    ? Exclude<T, undefined>
    : never;
  turnUsage?: {
    tokensIn: number;
    tokensOut: number;
    cachedTokens: number;
    totalTokens: number;
    costUsd: number;
    durationMs: number;
  };
}): ToolHandlerResponse {
  return {
    ok: true,
    name: result.name,
    output: result.output,
    sessionId: result.session.engineSessionId,
    session: serializeSession(result.session),
    routing: summarizeRoutingTrace(result.session.routingTrace),
    stats: {
      turn: result.turnUsage
        ? { ...result.turnUsage }
        : {
            tokensIn: 0,
            tokensOut: 0,
            cachedTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            durationMs: 0,
          },
      session: {
        tokensIn: result.session.tokenCount.input,
        tokensOut: result.session.tokenCount.output,
        cachedTokens: result.session.tokenCount.cachedInput,
        totalTokens: result.session.tokenCount.total,
        costUsd: result.session.costUsd,
      },
    },
  };
}

function serializeSession(session: {
  id: string;
  name: string;
  engine: EngineKind;
  model: string;
  status: string;
  createdAt: Date;
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
  lastTouchedAt: Date;
  lastError?: string;
  routingTrace?: {
    requestedModel: string | null;
    requestedEngine?: EngineKind;
    primary: {
      model: string;
      engine: EngineKind;
      subscriptionCovered: boolean;
      source: string;
    };
    fallbackChain: EngineKind[];
    attempts: { engine: EngineKind; model: string; ok: boolean; error?: string }[];
    selectedEngine?: EngineKind;
    selectedModel?: string;
  };
  activity: {
    phase: string;
    lastAction: string;
    updatedAt: Date;
    lastPromptPreview: string | null;
    lastResponsePreview: string | null;
    isRehydrated: boolean;
  };
}): Record<string, unknown> {
  return {
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
    routingTrace: session.routingTrace
      ? {
          requestedModel: session.routingTrace.requestedModel,
          requestedEngine: session.routingTrace.requestedEngine,
          primary: { ...session.routingTrace.primary },
          fallbackChain: [...session.routingTrace.fallbackChain],
          attempts: session.routingTrace.attempts.map((attempt) => ({ ...attempt })),
          selectedEngine: session.routingTrace.selectedEngine,
          selectedModel: session.routingTrace.selectedModel,
        }
      : undefined,
    routing: summarizeRoutingTrace(session.routingTrace),
    subscriptionCovered: session.engine === 'claude',
    activity: {
      phase: session.activity.phase,
      lastAction: session.activity.lastAction,
      updatedAt: session.activity.updatedAt.toISOString(),
      lastPromptPreview: session.activity.lastPromptPreview,
      lastResponsePreview: session.activity.lastResponsePreview,
      isRehydrated: session.activity.isRehydrated,
    },
  };
}

function summarizeRoutingTrace(
  trace:
    | {
        requestedModel: string | null;
        requestedEngine?: EngineKind;
        primary: {
          model: string;
          engine: EngineKind;
          subscriptionCovered: boolean;
          source: string;
        };
        fallbackChain: EngineKind[];
        attempts: { engine: EngineKind; model: string; ok: boolean; error?: string }[];
        selectedEngine?: EngineKind;
        selectedModel?: string;
      }
    | undefined,
): Record<string, unknown> | undefined {
  if (!trace) {
    return undefined;
  }

  return {
    requestedModel: trace.requestedModel,
    requestedEngine: trace.requestedEngine,
    primary: `${trace.primary.engine}/${trace.primary.model}`,
    selected: trace.selectedEngine && trace.selectedModel
      ? `${trace.selectedEngine}/${trace.selectedModel}`
      : undefined,
    attempts: trace.attempts.map((attempt) => ({
      route: `${attempt.engine}/${attempt.model}`,
      ok: attempt.ok,
      error: attempt.error,
    })),
  };
}

function serializeOverview(overview: ReturnType<SessionManager['getOverview']>) {
  return {
    ...overview,
    byEngine: Object.fromEntries(
      Object.entries(overview.byEngine).map(([engine, breakdown]) => [
        engine,
        serializeEngineBreakdown(breakdown),
      ]),
    ),
  };
}

function serializeCostReport(
  report: ReturnType<SessionManager['getCostReport']>,
): Record<string, unknown> {
  return {
    ...report,
    byEngine: Object.fromEntries(
      Object.entries(report.byEngine).map(([engine, breakdown]) => [
        engine,
        serializeEngineBreakdown(breakdown),
      ]),
    ),
  };
}

function serializeEngineBreakdown(breakdown: {
  sessionCount: number;
  costUsd: number;
  tokenCount: {
    input: number;
    output: number;
    cachedInput: number;
    total: number;
  };
}): Record<string, unknown> {
  return {
    sessionCount: breakdown.sessionCount,
    costUsd: breakdown.costUsd,
    tokenCount: { ...breakdown.tokenCount },
  };
}

function toSessionManagerConfig(
  config: SentinelBridgeConfig,
): import('./types.js').SentinelBridgeConfig {
  return {
    ttlMs: config.sessionTTLMs,
    cleanupIntervalMs: config.cleanupIntervalMs,
    maxConcurrentSessions: config.maxConcurrentSessions,
    defaultEngine: config.defaultEngine,
    defaultModel: config.defaultModel,
    defaultFallbackChain: config.defaultFallbackChain,
    claude: normalizeEngineConfig(config.engines?.claude),
    codex: normalizeEngineConfig(config.engines?.codex),
    grok: normalizeEngineConfig(config.engines?.grok),
  };
}

function normalizeEngineConfig(
  config?: PluginEngineConfig,
): Partial<import('./types.js').EngineConfig> | undefined {
  if (!config) {
    return undefined;
  }

  return {
    command: config.command,
    args: config.args,
    env: config.env,
    model: config.defaultModel ?? '',
    cwd: config.cwd,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  };
}

function getEngineDescriptor(
  engine: EngineKind,
  config: SentinelBridgeConfig,
): EngineDescriptor {
  const engineConfig = config.engines?.[engine];
  const enabled = engineConfig?.enabled !== false;
  const model = engineConfig?.defaultModel ?? null;

  if (!enabled) {
    return {
      id: engine,
      enabled,
      available: false,
      healthy: false,
      binary: null,
      authMethod: engine === 'grok' ? 'api-key' : 'cli',
      authValid: false,
      model,
      note: 'Engine is disabled in plugin config.',
    };
  }

  if (engine === 'grok') {
    const apiKey = resolveGrokApiKey(config);
    return {
      id: engine,
      enabled,
      available: Boolean(apiKey),
      healthy: Boolean(apiKey),
      binary: null,
      authMethod: 'api-key',
      authValid: Boolean(apiKey),
      model,
      note: apiKey ? undefined : 'Set XAI_API_KEY or configure engines.grok.apiKey.',
    };
  }

  const command = engineConfig?.command ?? DEFAULT_ENGINE_COMMANDS[engine];
  const binary = resolveCommandPath(command);
  const authMethod = engine === 'claude' ? 'subscription-cli' : 'cli';

  return {
    id: engine,
    enabled,
    available: Boolean(binary),
    healthy: Boolean(binary),
    binary,
    authMethod,
    authValid: Boolean(binary),
    model,
    note: binary
      ? undefined
      : `Command "${command ?? DEFAULT_ENGINE_COMMANDS[engine]}" not found on PATH.`,
  };
}

function resolveGrokApiKey(config: SentinelBridgeConfig): string | undefined {
  return (
    config.engines?.grok?.apiKey ??
    config.engines?.grok?.env?.XAI_API_KEY ??
    process?.env?.XAI_API_KEY
  );
}

function resolveCommandPath(command?: string): string | null {
  if (!command) {
    return null;
  }

  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    const absolutePath = isAbsolute(command)
      ? command
      : resolvePath(command);
    return isExecutable(absolutePath) ? absolutePath : null;
  }

  const pathValue = process?.env?.PATH ?? '';
  const extensions =
    process?.platform === 'win32'
      ? (process?.env?.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
      : [''];

  for (const directory of pathValue.split(delimiter)) {
    if (!directory) {
      continue;
    }

    for (const extension of extensions) {
      const candidatePath = resolvePath(directory, `${command}${extension}`);
      if (isExecutable(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return null;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
