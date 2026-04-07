import { describe, it, expect } from 'vitest';

import { routeTask } from '../orchestration/task-router.js';
import type { EngineAvailability } from '../orchestration/task-router.js';
import type { EngineKind } from '../types.js';

function allAvailable(engine: EngineKind): EngineAvailability {
  return { engine, available: true, healthy: true };
}

function onlyAvailable(...engines: EngineKind[]) {
  return (engine: EngineKind): EngineAvailability => ({
    engine,
    available: engines.includes(engine),
    healthy: engines.includes(engine),
  });
}

describe('routeTask', () => {
  it('should recommend Codex or Claude for code generation tasks', () => {
    const result = routeTask(
      'Implement a REST API endpoint with authentication',
      allAvailable,
    );
    expect(['claude', 'codex']).toContain(result.recommendedEngine);
  });

  it('should recommend Claude for reasoning tasks', () => {
    const result = routeTask(
      'Analyze the trade-offs between microservices and monolith architecture, evaluate pros and cons',
      allAvailable,
    );
    expect(result.recommendedEngine).toBe('claude');
  });

  it('should recommend Grok for fast tasks', () => {
    const result = routeTask(
      'Summarize this quickly in one sentence, give me a brief list',
      allAvailable,
    );
    expect(result.recommendedEngine).toBe('grok');
  });

  it('should recommend Ollama for local/private tasks', () => {
    const result = routeTask(
      'Process this sensitive data locally and keep it private, no cloud',
      allAvailable,
    );
    expect(result.recommendedEngine).toBe('ollama');
  });

  it('should filter unavailable engines', () => {
    const result = routeTask(
      'Process this data locally and keep it private',
      onlyAvailable('claude', 'grok'),
    );
    expect(result.recommendedEngine).not.toBe('ollama');
    expect(['claude', 'grok']).toContain(result.recommendedEngine);
  });

  it('should respect prefer=fast', () => {
    const result = routeTask(
      'Summarize this text quickly',
      allAvailable,
      'fast',
    );
    // Grok is the fastest for non-code tasks
    expect(['grok', 'ollama']).toContain(result.recommendedEngine);
  });

  it('should respect prefer=cheap', () => {
    const result = routeTask(
      'Write some code',
      allAvailable,
      'cheap',
    );
    // Ollama is free
    expect(['ollama', 'grok']).toContain(result.recommendedEngine);
  });

  it('should respect prefer=capable', () => {
    const result = routeTask(
      'Do something',
      allAvailable,
      'capable',
    );
    // Claude is the most capable
    expect(['claude', 'codex']).toContain(result.recommendedEngine);
  });

  it('should provide alternatives', () => {
    const result = routeTask(
      'Implement a function',
      allAvailable,
    );
    expect(result.alternatives.length).toBeGreaterThan(0);
    for (const alt of result.alternatives) {
      expect(alt.engine).toBeDefined();
      expect(alt.model).toBeDefined();
      expect(alt.reasoning).toBeDefined();
      expect(alt.estimatedCostTier).toBeDefined();
    }
  });

  it('should provide classification in result', () => {
    const result = routeTask(
      'Analyze this code for bugs',
      allAvailable,
    );
    expect(result.classification).toBeDefined();
    expect(result.classification.primary).toBeDefined();
  });

  it('should handle no available engines gracefully', () => {
    const result = routeTask(
      'Do something',
      () => ({ engine: 'claude' as EngineKind, available: false, healthy: false }),
    );
    expect(result.recommendedEngine).toBe('claude');
    expect(result.confidence).toBe('low');
    expect(result.alternatives).toEqual([]);
  });

  it('should set confidence based on signal strength', () => {
    const strong = routeTask(
      'Implement a new TypeScript function to fix the bug in parser.ts with refactoring',
      allAvailable,
    );
    expect(strong.confidence).toBe('high');

    const weak = routeTask(
      'hello',
      allAvailable,
    );
    expect(weak.confidence).toBe('low');
  });
});
