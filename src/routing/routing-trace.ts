import type {
  EngineKind,
  ModelRoute,
  RoutingTrace,
  RoutingTraceAttempt,
} from '../types.js';

export function createRoutingTrace(input: {
  requestedModel?: string;
  requestedEngine?: EngineKind;
  primary: ModelRoute;
  fallbackChain: EngineKind[];
}): RoutingTrace {
  return {
    requestedModel: input.requestedModel?.trim() || null,
    requestedEngine: input.requestedEngine,
    primary: input.primary,
    fallbackChain: [...input.fallbackChain],
    attempts: [],
  };
}

export function appendRoutingAttempt(
  trace: RoutingTrace,
  attempt: RoutingTraceAttempt,
): RoutingTrace {
  trace.attempts.push(attempt);
  if (attempt.ok) {
    trace.selectedEngine = attempt.engine;
    trace.selectedModel = attempt.model;
  }
  return trace;
}

export function toRoutingAttempt(input: {
  engine: EngineKind;
  model: string;
  error?: unknown;
}): RoutingTraceAttempt {
  const message =
    input.error instanceof Error ? input.error.message : input.error ? String(input.error) : undefined;

  return {
    engine: input.engine,
    model: input.model,
    ok: !message,
    error: message,
  };
}
