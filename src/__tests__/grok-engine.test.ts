import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GrokEngine } from '../engines/grok-engine.js';
import { EngineError } from '../errors.js';

/* ── Fetch mock ───────────────────────────────────────────────── */

const fetchMock = vi.fn<typeof globalThis.fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  fetchMock.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ── Helpers ──────────────────────────────────────────────────── */

function okResponse(
  text: string,
  usage?: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: text } }],
      usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function errorResponse(
  status: number,
  body: string | Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers },
  );
}

function makeEngine(overrides?: Record<string, unknown>) {
  return new GrokEngine({
    model: 'grok-4-1-fast',
    apiKey: 'xai-test-key',
    ...overrides,
  } as any);
}

/** Creates a fetch mock that rejects when the AbortSignal fires. */
function abortablePending(): Promise<Response> {
  return new Promise((_resolve, reject) => {
    // We'll check the signal in the fetchMock implementation instead
    // The GrokEngine sets up its own AbortController, so we hook into it
    const checkInterval = setInterval(() => {
      // This won't fire because we're using fake timers
      // Instead we rely on the signal being passed to fetch
    }, 10);
    // Clean up if resolved
    setTimeout(() => clearInterval(checkInterval), 100_000);
  });
}

/* ── Tests ────────────────────────────────────────────────────── */

describe('GrokEngine', () => {
  describe('start()', () => {
    it('validates model is required', async () => {
      const engine = new GrokEngine({ model: '' } as any);
      await expect(engine.start()).rejects.toThrow('model is required');
      expect(engine.status().state).toBe('error');
    });

    it('validates API key is required', async () => {
      const engine = new GrokEngine({ model: 'grok-3' } as any);
      await expect(engine.start()).rejects.toThrow('XAI API key');
      expect(engine.status().state).toBe('error');
    });

    it('throws EngineError with auth_expired for missing key', async () => {
      const engine = new GrokEngine({ model: 'grok-3' } as any);
      await expect(engine.start()).rejects.toBeInstanceOf(EngineError);
    });

    it('generates a session ID on start', async () => {
      const engine = makeEngine();
      await engine.start();
      expect(engine.getSessionId()).toBeTruthy();
      expect(engine.status().state).toBe('running');
    });

    it('preserves resumeSessionId', async () => {
      const engine = makeEngine({ resumeSessionId: 'sess-abc' });
      await engine.start();
      expect(engine.getSessionId()).toBe('sess-abc');
    });
  });

  describe('send()', () => {
    it('sends a message and returns assistant content', async () => {
      fetchMock.mockResolvedValueOnce(okResponse('Hello from Grok'));
      const engine = makeEngine();
      await engine.start();

      const result = await engine.send('Hi');
      expect(result).toBe('Hello from Grok');
      expect(engine.status().state).toBe('running');
    });

    it('returns empty string for blank message', async () => {
      const engine = makeEngine();
      await engine.start();
      const result = await engine.send('  ');
      expect(result).toBe('');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accumulates usage across sends', async () => {
      vi.useRealTimers();
      const usage1 = { prompt_tokens: 100, completion_tokens: 50 };
      const usage2 = { prompt_tokens: 80, completion_tokens: 30 };

      fetchMock
        .mockResolvedValueOnce(okResponse('r1', usage1))
        .mockResolvedValueOnce(okResponse('r2', usage2));

      const engine = makeEngine();
      await engine.start();
      await engine.send('first');
      await engine.send('second');

      const status = engine.status();
      expect(status.usage.tokenCount.input).toBe(180);
      expect(status.usage.tokenCount.output).toBe(80);
    });

    it('extracts cost_in_usd_ticks', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse('resp', {
          prompt_tokens: 100,
          completion_tokens: 50,
          cost_in_usd_ticks: 5_000_000_000, // $0.50
        }),
      );

      const engine = makeEngine();
      await engine.start();
      await engine.send('test');
      expect(engine.status().usage.costUsd).toBeCloseTo(0.5, 2);
    });

    it('handles content as array of text blocks', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                role: 'assistant',
                content: [
                  { type: 'text', text: 'Hello ' },
                  { type: 'text', text: 'World' },
                ],
              },
            }],
          }),
          { status: 200 },
        ),
      );

      const engine = makeEngine();
      await engine.start();
      const result = await engine.send('test');
      expect(result).toBe('Hello World');
    });
  });

  describe('send() errors', () => {
    it('classifies 401 as auth_expired', async () => {
      fetchMock.mockResolvedValueOnce(
        errorResponse(401, { error: 'Unauthorized' }),
      );

      const engine = makeEngine();
      await engine.start();

      try {
        await engine.send('test');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError);
        expect((e as EngineError).category).toBe('auth_expired');
      }
    });

    it('classifies 429 as rate_limited and marks retriable', { timeout: 15_000 }, async () => {
      vi.useRealTimers();
      // Return 429 for all retry attempts (MAX_RETRIES + 1 = 4)
      for (let i = 0; i < 4; i++) {
        fetchMock.mockResolvedValueOnce(
          errorResponse(429, { error: 'Too many requests' }, { 'retry-after': '0' }),
        );
      }

      const engine = makeEngine({ timeoutMs: 60_000 });
      await engine.start();

      try {
        await engine.send('test');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError);
        expect((e as EngineError).category).toBe('rate_limited');
        expect((e as EngineError).retriable).toBe(true);
      }
    });

    it('classifies 500 as transient and marks retriable', { timeout: 15_000 }, async () => {
      vi.useRealTimers();
      for (let i = 0; i < 4; i++) {
        fetchMock.mockResolvedValueOnce(
          errorResponse(500, 'Internal Server Error'),
        );
      }

      const engine = makeEngine({ timeoutMs: 60_000 });
      await engine.start();

      try {
        await engine.send('test');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError);
        expect((e as EngineError).category).toBe('transient');
        expect((e as EngineError).retriable).toBe(true);
      }
    });

    it('retries transient errors and succeeds on retry', async () => {
      vi.useRealTimers();
      fetchMock
        .mockResolvedValueOnce(errorResponse(500, 'fail'))
        .mockResolvedValueOnce(okResponse('recovered'));

      const engine = makeEngine({ timeoutMs: 60_000 });
      await engine.start();

      const result = await engine.send('test');
      expect(result).toBe('recovered');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws EngineError for non-JSON 502 response', { timeout: 15_000 }, async () => {
      vi.useRealTimers();
      // 502 is transient, so provide enough mocks for retries
      for (let i = 0; i < 4; i++) {
        fetchMock.mockResolvedValueOnce(
          new Response('<html>Bad Gateway</html>', { status: 502 }),
        );
      }

      const engine = makeEngine({ timeoutMs: 60_000 });
      await engine.start();

      try {
        await engine.send('test');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError);
      }
    });

    it('classifies 403 as auth_expired (no retry)', async () => {
      fetchMock.mockResolvedValueOnce(
        errorResponse(403, { error: 'Forbidden' }),
      );

      const engine = makeEngine();
      await engine.start();

      try {
        await engine.send('test');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError);
        expect((e as EngineError).category).toBe('auth_expired');
        // auth errors are not retriable → only 1 fetch call
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('compact()', () => {
    it('sends compact prompt and resets message history', async () => {
      fetchMock
        .mockResolvedValueOnce(okResponse('first reply'))
        .mockResolvedValueOnce(okResponse('compacted summary'));

      const engine = makeEngine();
      await engine.start();
      await engine.send('initial context');
      const result = await engine.compact();

      expect(result).toBe('compacted summary');
      // Verify the compact prompt was sent
      const lastCall = fetchMock.mock.calls[1]!;
      const body = JSON.parse(lastCall[1]?.body as string);
      expect(body.messages.at(-1).content).toContain('Compact');
    });
  });

  describe('cancel()', () => {
    it('stays in running state after cancel', async () => {
      const engine = makeEngine();
      await engine.start();
      engine.cancel(); // no-op when nothing in flight
      expect(engine.status().state).toBe('running');
    });
  });

  describe('stop()', () => {
    it('transitions to stopped state', async () => {
      const engine = makeEngine();
      await engine.start();
      await engine.stop();
      expect(engine.status().state).toBe('stopped');
    });
  });

  describe('status()', () => {
    it('returns full status snapshot', async () => {
      const engine = makeEngine();
      await engine.start();
      const status = engine.status();
      expect(status.state).toBe('running');
      expect(status.model).toBe('grok-4-1-fast');
      expect(status.sessionId).toBeTruthy();
      expect(status.usage.costUsd).toBe(0);
    });
  });

  describe('pricing', () => {
    it('uses grok-4-1-fast pricing', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse('resp', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }),
      );

      const engine = makeEngine({ model: 'grok-4-1-fast' });
      await engine.start();
      await engine.send('test');

      // grok-4-1-fast: input=$0.20/1M, output=$0.50/1M → total $0.70
      expect(engine.status().usage.costUsd).toBeCloseTo(0.7, 1);
    });

    it('uses grok-3 (flagship) pricing for non-fast models', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse('resp', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }),
      );

      const engine = makeEngine({ model: 'grok-3' });
      await engine.start();
      await engine.send('test');

      // grok-3: input=$3/1M, output=$15/1M → total $18
      expect(engine.status().usage.costUsd).toBeCloseTo(18, 0);
    });
  });
});
