/**
 * MCP Tool Registry — bridges sentinel-bridge tools to MCP format.
 *
 * Reuses the SessionManager and its operations directly, converting
 * the existing tool handlers into MCP-compatible format.
 */

import { SessionManager } from '../session-manager.js';
import type { RoutingStrategy } from '../orchestration/adaptive-router.js';
import type { EngineKind } from '../types.js';
import type { McpTool, McpToolHandler } from './server.js';

const ENGINE_KINDS: EngineKind[] = ['claude', 'codex', 'grok', 'ollama'];

export interface McpToolRegistration {
  definition: McpTool;
  handler: McpToolHandler;
}

export function buildMcpTools(manager: SessionManager): McpToolRegistration[] {
  const tools: McpToolRegistration[] = [];

  function add(name: string, description: string, inputSchema: Record<string, unknown>, handler: McpToolHandler) {
    tools.push({ definition: { name, description, inputSchema }, handler });
  }

  // ── Session Lifecycle ────────────────────────────────────────

  add('sb_session_start',
    'Start a new engine session. Supports fallback chain, roles, and multi-engine routing.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name' },
        engine: { type: 'string', enum: ENGINE_KINDS, description: 'Engine (default: from config)' },
        model: { type: 'string', description: 'Model override' },
        cwd: { type: 'string', description: 'Working directory' },
        resumeSessionId: { type: 'string', description: 'Resume existing session' },
        role: { type: 'string', description: 'Agent role (architect, implementer, reviewer, tester)' },
      },
      required: ['name'],
    },
    async (params) => {
      const session = await manager.startSession({
        name: params.name as string,
        engine: params.engine as EngineKind | undefined,
        model: params.model as string | undefined,
        cwd: params.cwd as string | undefined,
        resumeSessionId: params.resumeSessionId as string | undefined,
        role: params.role as string | undefined,
      });
      return { ok: true, session };
    },
  );

  add('sb_session_send',
    'Send a message to an active session and get the response.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name' },
        message: { type: 'string', description: 'Message to send' },
      },
      required: ['name', 'message'],
    },
    async (params) => {
      const result = await manager.sendMessage(params.name as string, params.message as string);
      return { ok: true, name: result.name, output: result.output, turnUsage: result.turnUsage };
    },
  );

  add('sb_session_stop', 'Stop and clean up a session.', {
    type: 'object',
    properties: { name: { type: 'string', description: 'Session name' } },
    required: ['name'],
  }, async (params) => {
    await manager.stopSession(params.name as string);
    return { ok: true, name: params.name, status: 'stopped' };
  });

  add('sb_session_cancel', 'Cancel in-flight operation without stopping the session.', {
    type: 'object',
    properties: { name: { type: 'string', description: 'Session name' } },
    required: ['name'],
  }, async (params) => {
    const session = manager.cancelSession(params.name as string);
    return { ok: true, name: params.name, status: session.status };
  });

  add('sb_session_list', 'List all active sessions.', { type: 'object', properties: {} },
    async () => ({ ok: true, sessions: manager.listSessions() }));

  add('sb_session_status', 'Get detailed status of a session.', {
    type: 'object',
    properties: { name: { type: 'string', description: 'Session name' } },
    required: ['name'],
  }, async (params) => {
    const session = manager.getSessionStatus(params.name as string);
    if (!session) throw new Error(`Session "${params.name}" not found.`);
    return { ok: true, session };
  });

  add('sb_session_overview', 'Aggregate overview: sessions, costs, engine health.', { type: 'object', properties: {} },
    async () => ({ ok: true, overview: manager.getOverview() }));

  add('sb_session_events', 'Return last N events from session timeline.', {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Session name' },
      limit: { type: 'number', description: 'Max events (default 20)' },
    },
    required: ['name'],
  }, async (params) => {
    const limit = typeof params.limit === 'number' ? params.limit : 20;
    return { ok: true, events: manager.events.listEvents(params.name as string, limit) };
  });

  add('sb_compact', 'Compact session context.', {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Session name' },
      summary: { type: 'string', description: 'Compaction guidance' },
    },
    required: ['name'],
  }, async (params) => {
    const result = await manager.compactSession(params.name as string, params.summary as string | undefined);
    return { ok: true, output: result.output, turnUsage: result.turnUsage };
  });

  // ── Engines & Routing ────────────────────────────────────────

  add('sb_engine_list', 'List available engines.', { type: 'object', properties: {} },
    async () => ({
      ok: true,
      engines: manager.getAllCircuitStates(),
      health: manager.getHealthResults(),
    }));

  add('sb_engine_status', 'Check health and status of a specific engine.', {
    type: 'object',
    properties: { engine: { type: 'string', enum: ENGINE_KINDS } },
    required: ['engine'],
  }, async (params) => ({
    ok: true,
    engine: params.engine,
    circuit: manager.getCircuitState(params.engine as EngineKind),
    health: manager.healthChecker.getResult(params.engine as EngineKind) ?? null,
  }));

  add('sb_model_route', 'Resolve a model ref to the engine that will serve it.', {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'Model ref (e.g. claude/opus)' },
      engine: { type: 'string', enum: ENGINE_KINDS, description: 'Preferred engine' },
    },
    required: ['model'],
  }, async (params) => {
    const route = manager.resolveModelRoute(params.model as string, params.engine as EngineKind | undefined);
    return { ok: true, ...route };
  });

  add('sb_cost_report', 'Cost aggregation across sessions.', {
    type: 'object',
    properties: { since: { type: 'string', description: 'ISO date' } },
  }, async (params) => ({ ok: true, report: manager.getCostReport(params.since as string | undefined) }));

  add('sb_route_task', 'Analyze task description and recommend best engine/model.', {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description' },
      prefer: { type: 'string', enum: ['fast', 'cheap', 'capable'] },
    },
    required: ['task'],
  }, async (params) => {
    const { routeTask } = await import('../orchestration/task-router.js');
    return {
      ok: true,
      ...routeTask(params.task as string, (engine) => {
        const circuit = manager.getCircuitState(engine);
        return { engine, available: circuit.state !== 'open', healthy: circuit.state === 'closed' };
      }, params.prefer as 'fast' | 'cheap' | 'capable' | undefined),
    };
  });

  add('sb_routing_stats', 'Show adaptive routing statistics (Thompson Sampling Beta parameters per engine:category).', {
    type: 'object',
    properties: {
      engine: { type: 'string', enum: ['claude', 'codex', 'grok', 'ollama'] },
      category: { type: 'string' },
    },
  }, async (params) => {
    const stats = manager.getAdaptiveRoutingStats(
      params.engine as EngineKind | undefined,
      params.category as string | undefined,
    );
    return { ok: true, count: stats.length, stats };
  });

  add('sb_routing_config', 'Get or set the adaptive routing strategy.', {
    type: 'object',
    properties: {
      strategy: { type: 'string', enum: ['thompson', 'ema', 'blended', 'knn', 'ensemble', 'static'], description: 'Set routing strategy. Omit to just read current.' },
    },
  }, async (params) => {
    if (params.strategy) {
      manager.setRoutingStrategy(params.strategy as RoutingStrategy);
    }
    return { ok: true, strategy: manager.getRoutingStrategy() };
  });

  // ── Context (Blackboard) ─────────────────────────────────────

  add('sb_context_set', 'Set a value in shared workspace context.', {
    type: 'object',
    properties: {
      workspace: { type: 'string' },
      key: { type: 'string' },
      value: { description: 'JSON-serializable value' },
      session: { type: 'string', description: 'Session name writing this' },
    },
    required: ['workspace', 'key', 'value', 'session'],
  }, async (params) => {
    const entry = await manager.setContext(params.workspace as string, params.key as string, params.value, params.session as string);
    return { ok: true, entry };
  });

  add('sb_context_get', 'Get a value from shared context.', {
    type: 'object',
    properties: { workspace: { type: 'string' }, key: { type: 'string' } },
    required: ['workspace', 'key'],
  }, async (params) => ({
    ok: true,
    entry: manager.getContext(params.workspace as string, params.key as string) ?? null,
  }));

  add('sb_context_list', 'List all entries in a workspace context.', {
    type: 'object',
    properties: { workspace: { type: 'string' } },
    required: ['workspace'],
  }, async (params) => ({
    ok: true,
    entries: manager.listContext(params.workspace as string),
  }));

  add('sb_context_clear', 'Clear all entries in a workspace.', {
    type: 'object',
    properties: {
      workspace: { type: 'string' },
      session: { type: 'string', description: 'Session performing the clear' },
    },
    required: ['workspace', 'session'],
  }, async (params) => {
    await manager.clearContext(params.workspace as string, params.session as string);
    return { ok: true };
  });

  // ── Roles ────────────────────────────────────────────────────

  add('sb_role_list', 'List available agent roles.', { type: 'object', properties: {} },
    async () => ({ ok: true, roles: manager.roles.list() }));

  add('sb_role_get', 'Get details of a specific role.', {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  }, async (params) => {
    const role = manager.roles.get(params.id as string);
    if (!role) throw new Error(`Role "${params.id}" not found.`);
    return { ok: true, role };
  });

  add('sb_role_register', 'Register a custom agent role.', {
    type: 'object',
    properties: {
      id: { type: 'string' }, name: { type: 'string' },
      description: { type: 'string' }, systemPrompt: { type: 'string' },
      preferredEngine: { type: 'string', enum: ENGINE_KINDS },
      preferredModel: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['id', 'name', 'description', 'systemPrompt'],
  }, async (params) => {
    const role = {
      id: params.id as string, name: params.name as string,
      description: params.description as string, systemPrompt: params.systemPrompt as string,
      preferredEngine: params.preferredEngine as EngineKind | undefined,
      preferredModel: params.preferredModel as string | undefined,
      tags: params.tags as string[] | undefined,
    };
    manager.registerRole(role);
    return { ok: true, role };
  });

  // ── Relay ────────────────────────────────────────────────────

  add('sb_session_relay', 'Relay a message from one session to another.', {
    type: 'object',
    properties: {
      from: { type: 'string' }, to: { type: 'string' }, message: { type: 'string' },
    },
    required: ['from', 'to', 'message'],
  }, async (params) => {
    const result = await manager.relayMessage(params.from as string, params.to as string, params.message as string);
    return { ok: true, from: result.from, to: result.to, output: result.sendResult.output };
  });

  add('sb_session_broadcast', 'Broadcast a message to all active sessions.', {
    type: 'object',
    properties: {
      from: { type: 'string' }, message: { type: 'string' },
      exclude: { type: 'array', items: { type: 'string' } },
    },
    required: ['from', 'message'],
  }, async (params) => {
    const result = await manager.broadcastMessage(params.from as string, params.message as string, params.exclude as string[] | undefined);
    return { ok: true, targets: result.targets, results: result.results };
  });

  // ── Workflows ────────────────────────────────────────────────

  add('sb_workflow_start', 'Start a multi-step workflow (DAG).', {
    type: 'object',
    properties: { definition: { type: 'object', description: 'WorkflowDefinition' } },
    required: ['definition'],
  }, async (params) => {
    const state = await manager.startWorkflow(params.definition as any);
    return { ok: true, workflow: state };
  });

  add('sb_workflow_status', 'Get workflow progress.', {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  }, async (params) => {
    const state = manager.getWorkflowStatus(params.id as string);
    if (!state) throw new Error(`Workflow "${params.id}" not found.`);
    return { ok: true, workflow: state };
  });

  add('sb_workflow_resume', 'Resume an interrupted workflow.', {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  }, async (params) => {
    const state = await manager.resumeWorkflow(params.id as string);
    return { ok: true, workflow: state };
  });

  add('sb_workflow_cancel', 'Cancel a running workflow.', {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  }, async (params) => {
    const state = manager.cancelWorkflow(params.id as string);
    return { ok: true, workflow: state };
  });

  add('sb_workflow_list', 'List all workflows.', { type: 'object', properties: {} },
    async () => ({ ok: true, workflows: manager.listWorkflows() }));

  add('sb_workflow_template', 'Generate a workflow from a template pattern.', {
    type: 'object',
    properties: {
      pattern: { type: 'string', enum: ['pipeline', 'fan-out-fan-in', 'autoresearch'] },
      id: { type: 'string' }, name: { type: 'string' }, workspace: { type: 'string' },
      steps: { type: 'array', items: { type: 'object' } },
      objective: { type: 'string', description: 'Research objective (for autoresearch pattern)' },
      maxIterations: { type: 'number', description: 'Max analysis iterations (for autoresearch, default 5)' },
      parallelExperiments: { type: 'number', description: 'Number of parallel experiments (for autoresearch, default 1)' },
    },
    required: ['pattern', 'id', 'name', 'workspace'],
  }, async (params) => {
    const { createPipelineWorkflow, createFanOutFanInWorkflow, createAutoresearchWorkflow } = await import('../orchestration/workflow-templates.js');
    const pattern = params.pattern as string;
    let definition;
    if (pattern === 'autoresearch') {
      const objective = (params.objective as string) ?? (params.steps as any)?.[0]?.task ?? 'Research objective not specified';
      definition = createAutoresearchWorkflow({
        id: params.id as string,
        name: params.name as string,
        workspace: params.workspace as string,
        objective,
        maxIterations: params.maxIterations as number | undefined,
        parallelExperiments: params.parallelExperiments as number | undefined,
      });
    } else {
      const steps = params.steps as any[];
      if (pattern === 'pipeline') {
        definition = createPipelineWorkflow(params.id as string, params.name as string, params.workspace as string, steps);
      } else {
        const fanOut = steps.slice(0, -1);
        const fanIn = steps[steps.length - 1];
        definition = createFanOutFanInWorkflow(params.id as string, params.name as string, params.workspace as string, fanOut, fanIn);
      }
    }
    return { ok: true, definition };
  });

  // ── Circuit Breaker ──────────────────────────────────────────

  add('sb_circuit_status', 'Show circuit breaker state for all engines.', { type: 'object', properties: {} },
    async () => ({ ok: true, circuits: manager.getAllCircuitStates() }));

  add('sb_circuit_reset', 'Reset circuit breaker for an engine.', {
    type: 'object',
    properties: { engine: { type: 'string', enum: ENGINE_KINDS } },
    required: ['engine'],
  }, async (params) => {
    manager.resetCircuit(params.engine as EngineKind);
    return { ok: true, engine: params.engine, circuit: manager.getCircuitState(params.engine as EngineKind) };
  });

  // ── Health ─────────────────────────────────────────────────

  add('sb_health_check', 'Run health probes on engines.', {
    type: 'object',
    properties: { engine: { type: 'string', enum: ENGINE_KINDS } },
  }, async (params) => {
    const results = await manager.runHealthCheck(params.engine as EngineKind | undefined);
    manager.startHealthChecks();
    return { ok: true, results };
  });

  return tools;
}
