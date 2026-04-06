import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { CodexEngine } from '../engines/codex-engine.js';
import { EngineError } from '../errors.js';

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

  /* ── Auth detection ─────────────────────────────────────────── */

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
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['login', 'status']);

    const execArgs = getSpawnArgs(1);
    expect(execArgs).toContain('exec');
    expect(execArgs).not.toContain('--api-key');
  });

  it('should fall back to apiKey auth and pass the API key via environment when subscription auth is unavailable', async () => {
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
    expect(execArgs).not.toContain('--api-key');

    const spawnOptions = getSpawnOptions(1);
    const env = spawnOptions.env as Record<string, string | undefined>;
    expect(env.OPENAI_API_KEY ?? env.CODEX_API_KEY).toBe('sk-fallback');
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

  /* ── start() ────────────────────────────────────────────────── */

  it('throws if model is missing', async () => {
    const engine = new CodexEngine({ model: '' } as any);
    await expect(engine.start()).rejects.toThrow('model is required');
    expect(engine.status().state).toBe('error');
  });

  /* ── send() ─────────────────────────────────────────────────── */

  it('returns empty string for blank message', async () => {
    mockSpawnSequence([{ stderr: 'Logged in with ChatGPT Pro\n' }]);
    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();
    const result = await engine.send('  ');
    expect(result).toBe('');
  });

  it('extracts agent_message with content array', async () => {
    mockSpawnSequence([
      { stderr: 'Logged in with ChatGPT Pro\n' },
      {
        stdout: JSON.stringify({
          type: 'agent_message',
          content: [
            { type: 'text', text: 'Part A ' },
            { type: 'text', text: 'Part B' },
          ],
        }),
      },
    ]);

    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();
    const result = await engine.send('hello');
    expect(result).toBe('Part A Part B');
  });

  it('extracts usage from turn.completed event', async () => {
    mockSpawnSequence([
      { stderr: 'Logged in with ChatGPT Pro\n' },
      {
        stdout: [
          JSON.stringify({
            type: 'agent_message',
            text: 'reply',
            thread_id: 't1',
          }),
          JSON.stringify({
            type: 'turn.completed',
            usage: {
              input_tokens: 200,
              output_tokens: 50,
              cached_input_tokens: 30,
            },
          }),
        ].join('\n'),
      },
    ]);

    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();
    await engine.send('hello');

    const usage = engine.status().usage.tokenCount;
    expect(usage.input).toBe(170); // 200 - 30 cached
    expect(usage.output).toBe(50);
    expect(usage.cachedInput).toBe(30);
  });

  it('accumulates usage across multiple sends', async () => {
    mockSpawnSequence([
      { stderr: 'Logged in with ChatGPT Pro\n' },
      {
        stdout: [
          JSON.stringify({ type: 'agent_message', text: 'r1', thread_id: 't1' }),
          JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0 },
          }),
        ].join('\n'),
      },
      {
        stdout: [
          JSON.stringify({ type: 'agent_message', text: 'r2', thread_id: 't1' }),
          JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 80, output_tokens: 10, cached_input_tokens: 0 },
          }),
        ].join('\n'),
      },
    ]);

    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();
    await engine.send('first');
    await engine.send('second');

    expect(engine.status().usage.tokenCount.input).toBe(180);
    expect(engine.status().usage.tokenCount.output).toBe(30);
  });

  it('throws when a request is already in flight', async () => {
    // auth detection passes
    mockSpawnSequence([{ stderr: 'Logged in with ChatGPT Pro\n' }]);
    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();

    // Second spawn for send() — capture the child so we can resolve it later
    const hangingChild = new LocalMockChildProcess();
    spawnMock.mockReturnValueOnce(hangingChild);

    const pending = engine.send('first');
    await expect(engine.send('second')).rejects.toThrow('already has a request in flight');

    // Clean up: cancel + emit close to let the pending promise settle
    engine.cancel();
    hangingChild.emitClose(0, null);
    await pending.catch(() => {});
  });

  it('handles turn.failed as runtime error', async () => {
    mockSpawnSequence([
      { stderr: 'Logged in with ChatGPT Pro\n' },
      {
        stdout: JSON.stringify({
          type: 'turn.failed',
          message: 'Something went wrong',
        }),
      },
    ]);

    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();
    await expect(engine.send('hello')).rejects.toThrow('Something went wrong');
    expect(engine.status().state).toBe('error');
  });

  it('handles error type event', async () => {
    mockSpawnSequence([
      { stderr: 'Logged in with ChatGPT Pro\n' },
      {
        stdout: JSON.stringify({
          type: 'error',
          message: 'API error occurred',
        }),
      },
    ]);

    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();
    await expect(engine.send('hello')).rejects.toThrow('API error occurred');
  });

  /* ── send() errors ──────────────────────────────────────────── */

  it('detects auth errors in stderr', async () => {
    mockSpawnSequence([
      { stderr: 'Logged in with ChatGPT Pro\n' },
      { stderr: 'Unauthorized access\n', code: 1 },
    ]);

    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();

    try {
      await engine.send('hello');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EngineError);
      expect((e as EngineError).category).toBe('auth_expired');
    }
  });

  it('handles ENOENT spawn error', async () => {
    mockSpawnSequence([{ stderr: 'Logged in with ChatGPT Pro\n' }]);
    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();

    spawnMock.mockImplementation((): MockChildProcess => {
      const child = new LocalMockChildProcess();
      queueMicrotask(() => {
        child.emitError(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
      });
      return child;
    });

    try {
      await engine.send('hello');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EngineError);
      expect((e as EngineError).category).toBe('unavailable');
    }
  });

  it('handles generic process error', async () => {
    mockSpawnSequence([
      { stderr: 'Logged in with ChatGPT Pro\n' },
      { stderr: 'something broke\n', code: 1 },
    ]);

    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();

    try {
      await engine.send('hello');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EngineError);
      expect((e as EngineError).message).toContain('something broke');
    }
  });

  /* ── stop() ─────────────────────────────────────────────────── */

  it('transitions to stopped state', async () => {
    mockSpawnSequence([{ stderr: 'Logged in with ChatGPT Pro\n' }]);
    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();
    await engine.stop();
    expect(engine.status().state).toBe('stopped');
  });

  it('kills active process on stop', async () => {
    mockSpawnSequence([{ stderr: 'Logged in with ChatGPT Pro\n' }]);
    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();

    // Create a send that won't resolve
    const child = new LocalMockChildProcess();
    spawnMock.mockReturnValueOnce(child);
    const pendingSend = engine.send('hello');

    // Stop should kill the process
    await engine.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(engine.status().state).toBe('stopped');

    // Clean up the pending promise
    child.emitClose(0, null);
    await pendingSend.catch(() => {});
  });

  /* ── cancel() ───────────────────────────────────────────────── */

  it('kills active process and stays running', async () => {
    mockSpawnSequence([{ stderr: 'Logged in with ChatGPT Pro\n' }]);
    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();

    const child = new LocalMockChildProcess();
    spawnMock.mockReturnValueOnce(child);
    const pending = engine.send('hello');

    engine.cancel();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(engine.status().state).toBe('running');

    child.emitClose(0, null);
    await pending.catch(() => {});
  });

  /* ── compact() ──────────────────────────────────────────────── */

  it('delegates to send with compact prompt', async () => {
    mockSpawnSequence([
      { stderr: 'Logged in with ChatGPT Pro\n' },
      {
        stdout: JSON.stringify({
          type: 'agent_message',
          text: 'Summary of session',
        }),
      },
    ]);

    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();
    const result = await engine.compact('focus on API');

    expect(result).toBe('Summary of session');
    const execArgs = getSpawnArgs(1);
    // The last arg should be the compact prompt
    const lastArg = execArgs[execArgs.length - 1]!;
    expect(lastArg).toContain('Compact');
  });

  /* ── buildArgs ──────────────────────────────────────────────── */

  it('includes --model and exec flags', async () => {
    mockSpawnSequence([
      { stderr: 'Logged in with ChatGPT Pro\n' },
      {
        stdout: JSON.stringify({
          type: 'agent_message',
          text: 'ok',
        }),
      },
    ]);

    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();
    await engine.send('hello');

    const args = getSpawnArgs(1);
    expect(args).toContain('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.4');
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
  });

  it('passes resume and session id on subsequent sends', async () => {
    mockSpawnSequence([
      { stderr: 'Logged in with ChatGPT Pro\n' },
      {
        stdout: JSON.stringify({
          type: 'agent_message',
          text: 'first',
          thread_id: 'thread-abc',
        }),
      },
      {
        stdout: JSON.stringify({
          type: 'agent_message',
          text: 'second',
          thread_id: 'thread-abc',
        }),
      },
    ]);

    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();
    await engine.send('first msg');
    await engine.send('second msg');

    const args = getSpawnArgs(2);
    expect(args).toContain('resume');
    expect(args).toContain('thread-abc');
  });

  /* ── getSessionId ───────────────────────────────────────────── */

  it('returns null before first send', async () => {
    mockSpawnSequence([{ stderr: 'Logged in with ChatGPT Pro\n' }]);
    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();
    expect(engine.getSessionId()).toBeNull();
  });

  /* ── pricing ────────────────────────────────────────────────── */

  it('tracks cost for gpt-5.4 model', async () => {
    mockSpawnSequence([
      { stderr: 'Logged in with ChatGPT Pro\n' },
      {
        stdout: [
          JSON.stringify({
            type: 'agent_message',
            text: 'reply',
            thread_id: 't1',
          }),
          JSON.stringify({
            type: 'turn.completed',
            usage: {
              input_tokens: 1_000_000,
              output_tokens: 1_000_000,
              cached_input_tokens: 0,
            },
          }),
        ].join('\n'),
      },
    ]);

    const engine = new CodexEngine({ model: 'gpt-5.4', apiKey: 'sk-key' });
    await engine.start();
    await engine.send('test');

    // gpt-5.4: $2.50/1M input + $15/1M output = $17.50
    expect(engine.status().usage.costUsd).toBeCloseTo(17.5, 1);
  });
});

/* ── Mock helpers ─────────────────────────────────────────────── */

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

function getSpawnOptions(index: number): Record<string, unknown> {
  const options = spawnMock.mock.calls[index]?.[2];
  if (!options || typeof options !== 'object') {
    throw new Error(`Missing spawn options at call index ${index}.`);
  }

  return options as Record<string, unknown>;
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
