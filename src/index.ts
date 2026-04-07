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
export { SessionManager } from './session-manager.js';
export type {
  CircuitBreakerConfig,
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
  SessionSummary,
  TurnUsage,
} from './types.js';
export type {
  WorkflowDefinition,
  WorkflowState,
  WorkflowStepDefinition,
} from './orchestration/workflow-types.js';
export type { SessionEvent, SessionEventType } from './sessions/session-events.js';
export { SessionEventStore } from './sessions/session-events.js';
export { SessionMutex } from './sessions/session-mutex.js';
export { StructuredLogger } from './logging.js';
export type { LogLevel, LogCategory, LogEntry, ExternalLogger } from './logging.js';
export { EngineError, toEngineError } from './errors.js';
export type { ErrorCategory } from './errors.js';
export type { AgentRole } from './orchestration/roles.js';
export type { CircuitSnapshot } from './orchestration/circuit-breaker.js';
export type { TaskRoutingResult } from './orchestration/task-router.js';
export { routeTask } from './orchestration/task-router.js';

type EngineKind = 'claude' | 'codex' | 'grok' | 'ollama';

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

const ENGINE_KINDS: EngineKind[] = ['claude', 'codex', 'grok', 'ollama'];
const DEFAULT_ENGINE_COMMANDS: Record<EngineKind, string | undefined> = {
  claude: 'claude',
  codex: 'codex',
  grok: undefined,
  ollama: undefined,
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
        '(default: claude → codex → grok → ollama); use an empty chain to disable.',
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
          role: {
            type: 'string',
            description: 'Agent role id (e.g. "architect", "implementer", "reviewer", "tester"). Sets system prompt and preferred engine/model.',
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
          role: readOptionalString(params, 'role'),
        });

        return {
          ok: true,
          session: serializeSession(session),
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_session_send',
      description:
        'Send a message to an active session and get the response. ' +
        'Set stream=true for incremental output (supported by Ollama and Grok engines).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          message: { type: 'string', description: 'Message to send' },
          stream: {
            type: 'boolean',
            description: 'Enable streaming for incremental output (default: false)',
          },
        },
        required: ['name', 'message'],
      },
      handler: async (params, ctx) => {
        const wantsStream = params['stream'] === true;
        const chunks: string[] = [];

        const onChunk = wantsStream
          ? (chunk: string) => { chunks.push(chunk); }
          : undefined;

        const result = await ctx.manager.sendMessage(
          readRequiredString(params, 'name'),
          readRequiredString(params, 'message'),
          onChunk,
        );

        const serialized = serializeTurnResult(result);
        if (wantsStream && chunks.length > 0) {
          serialized.streamed = true;
          serialized.chunkCount = chunks.length;
        }

        return serialized;
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
          circuit: ctx.manager.getCircuitState(engine),
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
    {
      name: 'sb_session_events',
      description: 'Return the last N events from the session event timeline.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
          limit: {
            type: 'number',
            description: 'Max events to return (default 20)',
          },
        },
        required: ['name'],
      },
      handler: async (params, ctx) => {
        const name = readRequiredString(params, 'name');
        const limit =
          typeof params['limit'] === 'number' ? params['limit'] : 20;
        const events = ctx.manager.events.listEvents(name, limit);

        return {
          ok: true,
          name,
          count: events.length,
          events,
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_session_cancel',
      description:
        'Cancel the current in-flight operation (send/compact) without stopping the session. ' +
        'The session remains active and can receive new messages.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name' },
        },
        required: ['name'],
      },
      handler: async (params, ctx) => {
        const name = readRequiredString(params, 'name');
        const session = ctx.manager.cancelSession(name);

        return {
          ok: true,
          name,
          status: session.status,
          phase: session.activity.phase,
        } satisfies ToolHandlerResponse;
      },
    },

    /* ── Context (Blackboard) tools ─────────────────────────────── */

    {
      name: 'sb_context_set',
      description:
        'Set a key-value pair in a shared workspace context (blackboard). ' +
        'Any session can read values set by other sessions within the same workspace.',
      parameters: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: 'Workspace identifier' },
          key: { type: 'string', description: 'Context key (1-128 chars)' },
          value: { description: 'JSON-serializable value to store' },
          session: { type: 'string', description: 'Session name that is writing this value' },
        },
        required: ['workspace', 'key', 'value', 'session'],
      },
      handler: async (params, ctx) => {
        const entry = await ctx.manager.setContext(
          readRequiredString(params, 'workspace'),
          readRequiredString(params, 'key'),
          params['value'],
          readRequiredString(params, 'session'),
        );

        return {
          ok: true,
          workspace: readRequiredString(params, 'workspace'),
          key: entry.key,
          entry,
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_context_get',
      description: 'Get a value from the shared workspace context by key.',
      parameters: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: 'Workspace identifier' },
          key: { type: 'string', description: 'Context key to retrieve' },
        },
        required: ['workspace', 'key'],
      },
      handler: async (params, ctx) => {
        const workspace = readRequiredString(params, 'workspace');
        const key = readRequiredString(params, 'key');
        const entry = ctx.manager.getContext(workspace, key);

        return {
          ok: true,
          workspace,
          key,
          found: entry !== undefined,
          entry: entry ?? null,
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_context_list',
      description: 'List all entries in a shared workspace context.',
      parameters: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: 'Workspace identifier' },
        },
        required: ['workspace'],
      },
      handler: async (params, ctx) => {
        const workspace = readRequiredString(params, 'workspace');
        const entries = ctx.manager.listContext(workspace);

        return {
          ok: true,
          workspace,
          count: entries.length,
          entries,
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_context_clear',
      description: 'Clear all entries in a shared workspace context.',
      parameters: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: 'Workspace identifier' },
          session: { type: 'string', description: 'Session name performing the clear' },
        },
        required: ['workspace', 'session'],
      },
      handler: async (params, ctx) => {
        const workspace = readRequiredString(params, 'workspace');
        await ctx.manager.clearContext(
          workspace,
          readRequiredString(params, 'session'),
        );

        return {
          ok: true,
          workspace,
        } satisfies ToolHandlerResponse;
      },
    },

    /* ── Circuit breaker tools ─────────────────────────────────── */

    {
      name: 'sb_circuit_status',
      description:
        'Show circuit breaker state for all engines. Engines with open circuits ' +
        'are automatically skipped during session start fallback.',
      parameters: { type: 'object', properties: {} },
      handler: async (_params, ctx) => {
        return {
          ok: true,
          circuits: ctx.manager.getAllCircuitStates(),
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_circuit_reset',
      description:
        'Manually reset a circuit breaker to closed state, re-enabling the engine.',
      parameters: {
        type: 'object',
        properties: {
          engine: { type: 'string', enum: ENGINE_KINDS, description: 'Engine to reset' },
        },
        required: ['engine'],
      },
      handler: async (params, ctx) => {
        const engine = readEngineKind(params, 'engine');
        if (!engine) {
          throw new Error('Engine is required.');
        }
        ctx.manager.resetCircuit(engine);

        return {
          ok: true,
          engine,
          circuit: ctx.manager.getCircuitState(engine),
        } satisfies ToolHandlerResponse;
      },
    },

    /* ── Task routing tools ──────────────────────────────────────── */

    {
      name: 'sb_route_task',
      description:
        'Analyze a task description and recommend the best engine and model. ' +
        'Advisory only — does not start a session. Use the prefer parameter ' +
        'to prioritize speed, cost, or capability.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Task description to analyze' },
          prefer: {
            type: 'string',
            enum: ['fast', 'cheap', 'capable'],
            description: 'Routing preference (default: balanced)',
          },
        },
        required: ['task'],
      },
      handler: async (params, ctx) => {
        const { routeTask } = await import('./orchestration/task-router.js');
        const task = readRequiredString(params, 'task');
        const prefer = readOptionalString(params, 'prefer') as 'fast' | 'cheap' | 'capable' | undefined;

        const result = routeTask(
          task,
          (engine) => {
            const descriptor = getEngineDescriptor(engine, ctx.config);
            return {
              engine,
              available: descriptor.available,
              healthy: descriptor.healthy,
            };
          },
          prefer,
        );

        return {
          ok: true,
          ...result,
        } satisfies ToolHandlerResponse;
      },
    },

    /* ── Workflow tools ──────────────────────────────────────────── */

    {
      name: 'sb_workflow_start',
      description:
        'Start a multi-step workflow defined as a DAG. Steps execute in dependency order, ' +
        'with parallel execution where possible. Each step creates a session and sends a task.',
      parameters: {
        type: 'object',
        properties: {
          definition: {
            type: 'object',
            description: 'WorkflowDefinition with id, name, workspace, and steps array',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              workspace: { type: 'string' },
              steps: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    sessionName: { type: 'string' },
                    role: { type: 'string' },
                    task: { type: 'string' },
                    dependsOn: { type: 'array', items: { type: 'string' } },
                    engine: { type: 'string', enum: ENGINE_KINDS },
                    model: { type: 'string' },
                  },
                  required: ['id', 'sessionName', 'task'],
                },
              },
            },
            required: ['id', 'name', 'workspace', 'steps'],
          },
        },
        required: ['definition'],
      },
      handler: async (params, ctx) => {
        const definition = params['definition'] as import('./orchestration/workflow-types.js').WorkflowDefinition;
        const state = await ctx.manager.startWorkflow(definition);

        return {
          ok: true,
          workflow: state,
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_workflow_status',
      description: 'Get the current status of a workflow and all its steps.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Workflow id' },
        },
        required: ['id'],
      },
      handler: async (params, ctx) => {
        const id = readRequiredString(params, 'id');
        const state = ctx.manager.getWorkflowStatus(id);
        if (!state) {
          throw new Error(`Workflow "${id}" not found.`);
        }

        return {
          ok: true,
          workflow: state,
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_workflow_resume',
      description:
        'Resume an interrupted or running workflow. Steps that were mid-flight ' +
        'are reset to pending and re-executed. Completed steps are preserved.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Workflow id to resume' },
        },
        required: ['id'],
      },
      handler: async (params, ctx) => {
        const id = readRequiredString(params, 'id');
        const state = await ctx.manager.resumeWorkflow(id);

        return {
          ok: true,
          workflow: state,
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_workflow_cancel',
      description: 'Cancel a running workflow. Pending steps are marked as skipped.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Workflow id' },
        },
        required: ['id'],
      },
      handler: async (params, ctx) => {
        const id = readRequiredString(params, 'id');
        const state = ctx.manager.cancelWorkflow(id);

        return {
          ok: true,
          id,
          status: state.status,
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_workflow_list',
      description: 'List all workflows and their status.',
      parameters: { type: 'object', properties: {} },
      handler: async (_params, ctx) => {
        const workflows = ctx.manager.listWorkflows();

        return {
          ok: true,
          count: workflows.length,
          workflows: workflows.map(w => ({
            id: w.id,
            name: w.definition.name,
            status: w.status,
            stepCount: Object.keys(w.steps).length,
            completedSteps: Object.values(w.steps).filter(s => s.status === 'completed').length,
            failedSteps: Object.values(w.steps).filter(s => s.status === 'failed').length,
            createdAt: w.createdAt,
            updatedAt: w.updatedAt,
          })),
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_workflow_template',
      description:
        'Generate a WorkflowDefinition from a template pattern without executing it. ' +
        'Supported patterns: "pipeline" (linear chain) and "fan-out-fan-in" (parallel + aggregator).',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            enum: ['pipeline', 'fan-out-fan-in'],
            description: 'Workflow pattern',
          },
          id: { type: 'string', description: 'Workflow id' },
          name: { type: 'string', description: 'Workflow name' },
          workspace: { type: 'string', description: 'Workspace for shared context' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                sessionName: { type: 'string' },
                task: { type: 'string' },
                role: { type: 'string' },
                engine: { type: 'string', enum: ENGINE_KINDS },
                model: { type: 'string' },
              },
              required: ['id', 'sessionName', 'task'],
            },
            description: 'Steps for the workflow. For fan-out-fan-in, the last step is the aggregator.',
          },
        },
        required: ['pattern', 'id', 'name', 'workspace', 'steps'],
      },
      handler: async (params, _ctx) => {
        const { createPipelineWorkflow, createFanOutFanInWorkflow } = await import('./orchestration/workflow-templates.js');
        const pattern = readRequiredString(params, 'pattern');
        const id = readRequiredString(params, 'id');
        const name = readRequiredString(params, 'name');
        const workspace = readRequiredString(params, 'workspace');
        const steps = params['steps'] as Array<{
          id: string;
          sessionName: string;
          task: string;
          role?: string;
          engine?: import('./types.js').EngineKind;
          model?: string;
        }>;

        let definition;
        if (pattern === 'pipeline') {
          definition = createPipelineWorkflow(id, name, workspace, steps);
        } else if (pattern === 'fan-out-fan-in') {
          if (steps.length < 2) {
            throw new Error('Fan-out-fan-in requires at least 2 steps (fan-out + aggregator).');
          }
          const fanOut = steps.slice(0, -1);
          const fanIn = steps[steps.length - 1];
          definition = createFanOutFanInWorkflow(id, name, workspace, fanOut, fanIn);
        } else {
          throw new Error(`Unknown pattern "${pattern}". Use "pipeline" or "fan-out-fan-in".`);
        }

        return {
          ok: true,
          pattern,
          definition,
        } satisfies ToolHandlerResponse;
      },
    },

    /* ── Relay tools ────────────────────────────────────────────── */

    {
      name: 'sb_session_relay',
      description:
        'Relay a message from one session to another. The message is sent as input to the target session. ' +
        'Use this to chain session outputs as inputs for pipeline workflows.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source session name' },
          to: { type: 'string', description: 'Target session name' },
          message: { type: 'string', description: 'Message to relay' },
          stream: {
            type: 'boolean',
            description: 'Enable streaming for incremental output (default: false)',
          },
        },
        required: ['from', 'to', 'message'],
      },
      handler: async (params, ctx) => {
        const wantsStream = params['stream'] === true;
        const chunks: string[] = [];
        const onChunk = wantsStream
          ? (chunk: string) => { chunks.push(chunk); }
          : undefined;

        const result = await ctx.manager.relayMessage(
          readRequiredString(params, 'from'),
          readRequiredString(params, 'to'),
          readRequiredString(params, 'message'),
          onChunk,
        );

        const serialized = serializeTurnResult(result.sendResult);
        serialized.relayFrom = result.from;
        serialized.relayTo = result.to;
        if (wantsStream && chunks.length > 0) {
          serialized.streamed = true;
          serialized.chunkCount = chunks.length;
        }

        return serialized;
      },
    },
    {
      name: 'sb_session_broadcast',
      description:
        'Broadcast a message to all active sessions (except the sender and optionally excluded sessions). ' +
        'Uses Promise.allSettled so one failure does not block others.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source session name' },
          message: { type: 'string', description: 'Message to broadcast' },
          exclude: {
            type: 'array',
            items: { type: 'string' },
            description: 'Session names to exclude from broadcast',
          },
        },
        required: ['from', 'message'],
      },
      handler: async (params, ctx) => {
        const exclude = Array.isArray(params['exclude']) ? params['exclude'] as string[] : undefined;
        const result = await ctx.manager.broadcastMessage(
          readRequiredString(params, 'from'),
          readRequiredString(params, 'message'),
          exclude,
        );

        return {
          ok: true,
          from: result.from,
          targets: result.targets,
          totalTargets: result.targets.length,
          succeeded: result.results.filter(r => r.ok).length,
          failed: result.results.filter(r => !r.ok).length,
          results: result.results.map(r => ({
            to: r.to,
            ok: r.ok,
            error: r.error,
          })),
        } satisfies ToolHandlerResponse;
      },
    },

    /* ── Role tools ─────────────────────────────────────────────── */

    {
      name: 'sb_role_list',
      description: 'List all available agent roles (built-in and custom).',
      parameters: { type: 'object', properties: {} },
      handler: async (_params, ctx) => {
        return {
          ok: true,
          roles: ctx.manager.roles.list(),
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_role_get',
      description: 'Get details of a specific agent role.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Role id (e.g. "architect")' },
        },
        required: ['id'],
      },
      handler: async (params, ctx) => {
        const id = readRequiredString(params, 'id');
        const role = ctx.manager.roles.get(id);
        if (!role) {
          throw new Error(`Role "${id}" not found.`);
        }

        return {
          ok: true,
          role,
        } satisfies ToolHandlerResponse;
      },
    },
    {
      name: 'sb_role_register',
      description:
        'Register a custom agent role with a system prompt and optional engine/model preferences.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique role id' },
          name: { type: 'string', description: 'Display name' },
          description: { type: 'string', description: 'Role description' },
          systemPrompt: { type: 'string', description: 'System prompt injected on session start' },
          preferredEngine: {
            type: 'string',
            enum: ENGINE_KINDS,
            description: 'Default engine for this role',
          },
          preferredModel: { type: 'string', description: 'Default model for this role' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for categorization',
          },
        },
        required: ['id', 'name', 'description', 'systemPrompt'],
      },
      handler: async (params, ctx) => {
        const role = {
          id: readRequiredString(params, 'id'),
          name: readRequiredString(params, 'name'),
          description: readRequiredString(params, 'description'),
          systemPrompt: readRequiredString(params, 'systemPrompt'),
          preferredEngine: readEngineKind(params, 'preferredEngine'),
          preferredModel: readOptionalString(params, 'preferredModel'),
          tags: Array.isArray(params['tags']) ? params['tags'] as string[] : undefined,
        };
        ctx.manager.registerRole(role);

        return {
          ok: true,
          role,
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
  const config = mergePluginConfig(DEFAULT_CONFIG, userConfig);
  const ctx: PluginContext = {
    config,
    manager: new SessionManager(toSessionManagerConfig(config), api.logger),
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

function mergePluginConfig(
  defaults: SentinelBridgeConfig,
  overrides: Partial<SentinelBridgeConfig>,
): SentinelBridgeConfig {
  return {
    ...defaults,
    ...overrides,
    engines: {
      claude: mergeEnginePluginConfig(defaults.engines?.claude, overrides.engines?.claude),
      codex: mergeEnginePluginConfig(defaults.engines?.codex, overrides.engines?.codex),
      grok: mergeEnginePluginConfig(defaults.engines?.grok, overrides.engines?.grok),
      ollama: mergeEnginePluginConfig(defaults.engines?.ollama, overrides.engines?.ollama),
    },
  };
}

function mergeEnginePluginConfig(
  base?: PluginEngineConfig,
  override?: PluginEngineConfig,
): PluginEngineConfig {
  if (!override) return { ...base };
  if (!base) return { ...override };
  return {
    ...base,
    ...override,
    env: base.env || override.env
      ? { ...base.env, ...override.env }
      : undefined,
  };
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
  turnCount: number;
  role?: string;
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
    turnCount: session.turnCount,
    role: session.role,
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
    sessions: overview.sessions.map((s) => ({
      ...s,
      updatedAt: s.updatedAt.toISOString(),
    })),
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
    circuitBreaker: config.circuitBreaker,
    claude: normalizeEngineConfig(config.engines?.claude),
    codex: normalizeEngineConfig(config.engines?.codex),
    grok: normalizeEngineConfig(config.engines?.grok),
    ollama: normalizeEngineConfig(config.engines?.ollama),
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
      authMethod: engine === 'grok' || engine === 'ollama' ? 'api-key' : 'cli',
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

  if (engine === 'ollama') {
    return {
      id: engine,
      enabled,
      available: true,  // Actual reachability checked on start()
      healthy: true,
      binary: null,
      authMethod: 'none',
      authValid: true,
      model,
      note: 'Ollama (local). Reachability verified on session start.',
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
