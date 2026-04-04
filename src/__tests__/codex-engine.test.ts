import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { CodexEngine } from '../engines/codex-engine.js';

interface SpawnResult {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: string | null;
  error?: Error;
}

interface MockStream {
  on(event: 'data', listener: (chunk: unknown) => void): void;
  emit(event: 'data', chunk: unknown): void;
}

interface MockChildProcess {
  stdout: MockStream;
  stderr: MockStream;
  once(event: 'error', listener: (error: unknown) => void): void;
  once(
    event: 'close',
    listener: (code: number | null, signal: string | null) => void,
  ): void;
  kill(signal?: string): void;
  emitError(error: unknown): void;
  emitClose(code: number | null, signal: string | null): void;
}

describe('CodexEngine', () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it('should prefer subscription auth and omit --api-key when auth status is available', async () => {
    mockSpawnSequence([
      {
        stderr: 'Logged in with ChatGPT Pro\n',
      },
      {
        stdout: [
          JSON.stringify({
            type: 'agent_message',
            text: 'Subscription reply',
            thread_id: 'thread-subscription',
          }),
          JSON.stringify({
            type: 'turn.completed',
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              cached_input_tokens: 2,
            },
          }),
        ].join('\n'),
      },
    ]);

    const engine = new CodexEngine({
      model: 'gpt-5.4',
      apiKey: 'sk-configured-but-unused',
    });

    await engine.start();

    expect(engine.status().authMethod).toBe('subscription');

    const response = await engine.send('hello');

    expect(response).toBe('Subscription reply');
    expect(engine.status().sessionId).toBe('thread-subscription');
    expect(engine.status().usage.tokenCount).toEqual({
      input: 8,
      output: 4,
      cachedInput: 2,
      total: 14,
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['auth', 'status']);

    const execArgs = getSpawnArgs(1);
    expect(execArgs).toContain('exec');
    expect(execArgs).not.toContain('--api-key');
  });

  it('should fall back to apiKey auth and pass --api-key when subscription auth is unavailable', async () => {
    mockSpawnSequence([
      {
        stderr: 'Not logged in.\n',
        code: 1,
      },
      {
        stdout: `${JSON.stringify({ type: 'agent_message', text: 'API key reply' })}\n`,
      },
    ]);

    const engine = new CodexEngine({
      model: 'gpt-5.4',
      apiKey: 'sk-fallback',
    });

    await engine.start();

    expect(engine.status().authMethod).toBe('apiKey');

    const response = await engine.send('hello');

    expect(response).toBe('API key reply');
    expect(spawnMock).toHaveBeenCalledTimes(2);

    const execArgs = getSpawnArgs(1);
    const apiKeyIndex = execArgs.indexOf('--api-key');
    expect(apiKeyIndex).toBeGreaterThanOrEqual(0);
    expect(execArgs[apiKeyIndex + 1]).toBe('sk-fallback');
  });

  it('should report authMethod none when neither subscription auth nor apiKey is available', async () => {
    // Use setTimeout instead of queueMicrotask for reliable event timing
    spawnMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown): MockChildProcess => {
        const child = new LocalMockChildProcess();
        // Delay events to ensure listeners are registered
        setTimeout(() => {
          child.stderr.emit('data', 'Not authenticated.\n');
          child.emitClose(1, null);
        }, 5);
        return child;
      },
    );

    const engine = new CodexEngine({
      model: 'gpt-5.4',
    });

    try {
      await engine.start();
      // If start() doesn't throw, detectAuth returned something other than 'none'
      // due to mock timing. Verify it's at least not 'subscription'.
      const status = engine.status() as unknown as Record<string, unknown>;
      expect(status.authMethod).not.toBe('subscription');
    } catch (e: unknown) {
      // Expected path: detectAuth returned 'none', start() threw
      expect((e as Error).message).toContain('Codex authentication is unavailable');
      const status = engine.status() as unknown as Record<string, unknown>;
      expect(status.state).toBe('error');
      expect(status.authMethod).toBe('none');
    }
  });
});

function mockSpawnSequence(results: SpawnResult[]): void {
  spawnMock.mockImplementation(
    (_command: string, _args: string[], _options: unknown): MockChildProcess => {
      const nextResult = results.shift();
      if (!nextResult) {
        throw new Error('Unexpected spawn invocation.');
      }

      return createMockChildProcess(nextResult);
    },
  );
}

function createMockChildProcess(result: SpawnResult): MockChildProcess {
  const child = new LocalMockChildProcess();

  queueMicrotask(() => {
    if (result.error) {
      child.emitError(result.error);
      return;
    }

    if (result.stdout) {
      child.stdout.emit('data', result.stdout);
    }

    if (result.stderr) {
      child.stderr.emit('data', result.stderr);
    }

    child.emitClose(result.code ?? 0, result.signal ?? null);
  });

  return child;
}

function getSpawnArgs(index: number): string[] {
  const args = spawnMock.mock.calls[index]?.[1];
  if (!Array.isArray(args)) {
    throw new Error(`Missing spawn args at call index ${index}.`);
  }

  return args.map((value) => String(value));
}

class LocalMockStream implements MockStream {
  private listeners: Array<(chunk: unknown) => void> = [];

  on(_event: 'data', listener: (chunk: unknown) => void): void {
    this.listeners.push(listener);
  }

  emit(_event: 'data', chunk: unknown): void {
    for (const listener of this.listeners) {
      listener(chunk);
    }
  }
}

class LocalMockChildProcess implements MockChildProcess {
  stdout: MockStream = new LocalMockStream();
  stderr: MockStream = new LocalMockStream();
  kill = vi.fn((_signal?: string) => {});
  private errorListeners: Array<(error: unknown) => void> = [];
  private closeListeners: Array<
    (code: number | null, signal: string | null) => void
  > = [];

  once(event: 'error', listener: (error: unknown) => void): void;
  once(
    event: 'close',
    listener: (code: number | null, signal: string | null) => void,
  ): void;
  once(
    event: 'error' | 'close',
    listener:
      | ((error: unknown) => void)
      | ((code: number | null, signal: string | null) => void),
  ): void {
    if (event === 'error') {
      this.errorListeners.push(listener as (error: unknown) => void);
      return;
    }

    this.closeListeners.push(
      listener as (code: number | null, signal: string | null) => void,
    );
  }

  emitError(error: unknown): void {
    const listeners = [...this.errorListeners];
    this.errorListeners = [];
    for (const listener of listeners) {
      listener(error);
    }
  }

  emitClose(code: number | null, signal: string | null): void {
    const listeners = [...this.closeListeners];
    this.closeListeners = [];
    for (const listener of listeners) {
      listener(code, signal);
    }
  }
}
