import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaEngine } from '../engines/ollama-engine.js';
import { EngineError } from '../errors.js';

describe('OllamaEngine', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetchResponse(body: object, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      headers: new Headers(),
    } as unknown as Response;
  }

  function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
  }

  function mockStreamResponse(sseLines: string[]) {
    const body = createSSEStream(sseLines.map((l) => l + '\n'));
    return {
      ok: true,
      status: 200,
      body,
      headers: new Headers(),
    } as unknown as Response;
  }

  it('validates model is required on start', async () => {
    const engine = new OllamaEngine({ model: '' });
    await expect(engine.start()).rejects.toThrow(/model is required/i);
  });

  it('checks Ollama reachability on start', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));

    const engine = new OllamaEngine({
      model: 'llama3.2',
      baseUrl: 'http://localhost:11434/v1',
    });
    await engine.start();
    expect(engine.status().state).toBe('running');
  });

  it('throws unavailable if Ollama is not reachable', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('fetch failed'));

    const engine = new OllamaEngine({ model: 'llama3.2' });

    try {
      await engine.start();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      expect((error as EngineError).category).toBe('unavailable');
    }
  });

  it('sends a message and returns assistant content', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        choices: [{ message: { role: 'assistant', content: 'Hello from Ollama!' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );

    const engine = new OllamaEngine({ model: 'llama3.2' });
    await engine.start();
    const response = await engine.send('Hello');

    expect(response).toBe('Hello from Ollama!');
    expect(engine.status().usage.tokenCount.input).toBe(10);
    expect(engine.status().usage.tokenCount.output).toBe(5);
    expect(engine.status().usage.costUsd).toBe(0);
  });

  it('throws with model not found hint on 404', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ error: 'model not found' }, 404),
    );

    const engine = new OllamaEngine({ model: 'nonexistent' });
    await engine.start();

    try {
      await engine.send('test');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      expect((error as EngineError).category).toBe('unavailable');
      expect((error as EngineError).message).toContain('ollama pull');
    }
  });

  it('classifies 500 as transient', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ error: 'internal error' }, 500),
    );
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ error: 'internal error' }, 500),
    );
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ error: 'internal error' }, 500),
    );

    const engine = new OllamaEngine({ model: 'llama3.2' });
    await engine.start();

    try {
      await engine.send('test');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      expect((error as EngineError).category).toBe('transient');
    }
  });

  it('cancel aborts in-flight request', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));

    const engine = new OllamaEngine({ model: 'llama3.2' });
    await engine.start();

    let rejectFn!: (reason: unknown) => void;
    fetchSpy.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectFn = reject; }),
    );

    const sendPromise = engine.send('test').catch((e) => e);
    engine.cancel();

    rejectFn(new DOMException('Aborted', 'AbortError'));
    const error = await sendPromise;
    expect(error).toBeInstanceOf(EngineError);
  });

  it('maintains conversation history across sends', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        choices: [{ message: { role: 'assistant', content: 'First' } }],
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({
        choices: [{ message: { role: 'assistant', content: 'Second' } }],
      }),
    );

    const engine = new OllamaEngine({ model: 'llama3.2' });
    await engine.start();

    await engine.send('msg1');
    await engine.send('msg2');

    const secondCallBody = JSON.parse(
      (fetchSpy.mock.calls[2]![1] as { body: string }).body,
    );
    expect(secondCallBody.messages).toHaveLength(3);
    expect(secondCallBody.messages[0].content).toBe('msg1');
    expect(secondCallBody.messages[1].content).toBe('First');
    expect(secondCallBody.messages[2].content).toBe('msg2');
  });

  it('reports cost as 0 in status', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));

    const engine = new OllamaEngine({ model: 'llama3.2' });
    await engine.start();

    const status = engine.status();
    expect(status.usage.costUsd).toBe(0);
    expect(status.model).toBe('llama3.2');
  });

  it('generates a session ID on start', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));

    const engine = new OllamaEngine({ model: 'llama3.2' });
    expect(engine.getSessionId()).toBeNull();

    await engine.start();
    expect(engine.getSessionId()).toBeTruthy();
  });

  describe('streaming', () => {
    it('streams chunks via onChunk callback when provided', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));

      const sseLines = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        'data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":5,"completion_tokens":3}}',
        'data: [DONE]',
      ];
      fetchSpy.mockResolvedValueOnce(mockStreamResponse(sseLines));

      const engine = new OllamaEngine({ model: 'llama3.2' });
      await engine.start();

      const chunks: string[] = [];
      const response = await engine.send('Hi', (chunk) => chunks.push(chunk));

      expect(response).toBe('Hello world!');
      expect(chunks).toEqual(['Hello', ' world', '!']);
      expect(engine.status().usage.tokenCount.input).toBe(5);
      expect(engine.status().usage.tokenCount.output).toBe(3);
    });

    it('sends stream=true in request body when onChunk is provided', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));

      const sseLines = [
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        'data: [DONE]',
      ];
      fetchSpy.mockResolvedValueOnce(mockStreamResponse(sseLines));

      const engine = new OllamaEngine({ model: 'llama3.2' });
      await engine.start();
      await engine.send('test', () => {});

      const requestBody = JSON.parse(
        (fetchSpy.mock.calls[1]![1] as { body: string }).body,
      );
      expect(requestBody.stream).toBe(true);
    });

    it('sends stream=false in request body when no onChunk', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        }),
      );

      const engine = new OllamaEngine({ model: 'llama3.2' });
      await engine.start();
      await engine.send('test');

      const requestBody = JSON.parse(
        (fetchSpy.mock.calls[1]![1] as { body: string }).body,
      );
      expect(requestBody.stream).toBe(false);
    });

    it('handles empty delta content gracefully', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));

      const sseLines = [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        'data: {"choices":[{"delta":{"content":"Hi"}}]}',
        'data: {"choices":[{"delta":{}}]}',
        'data: [DONE]',
      ];
      fetchSpy.mockResolvedValueOnce(mockStreamResponse(sseLines));

      const engine = new OllamaEngine({ model: 'llama3.2' });
      await engine.start();

      const chunks: string[] = [];
      const response = await engine.send('test', (chunk) => chunks.push(chunk));

      expect(response).toBe('Hi');
      expect(chunks).toEqual(['Hi']);
    });
  });

  describe('retry', () => {
    it('retries on transient 500 errors and succeeds', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));

      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ error: 'server overloaded' }, 500),
      );
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          choices: [{ message: { role: 'assistant', content: 'recovered' } }],
          usage: { prompt_tokens: 8, completion_tokens: 2 },
        }),
      );

      const engine = new OllamaEngine({ model: 'llama3.2' });
      await engine.start();
      const response = await engine.send('test');

      expect(response).toBe('recovered');
    });

    it('does not retry on non-retriable errors (404)', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ error: 'not found' }, 404),
      );

      const engine = new OllamaEngine({ model: 'nonexistent' });
      await engine.start();

      try {
        await engine.send('test');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(EngineError);
        expect((error as EngineError).category).toBe('unavailable');
      }

      // health check + 1 send attempt = 2 fetch calls total (no retry)
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('exhausts retries and throws the last error', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ error: 'err' }, 500));
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ error: 'err' }, 500));
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ error: 'err' }, 500));

      const engine = new OllamaEngine({ model: 'llama3.2' });
      await engine.start();

      try {
        await engine.send('test');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(EngineError);
        expect((error as EngineError).category).toBe('transient');
      }

      // health check + 3 attempts (1 initial + 2 retries) = 4
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });
  });

  describe('context overflow', () => {
    it('classifies context overflow error as context_overflow', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ error: 'context length exceeded, too long' }, 400),
      );

      const engine = new OllamaEngine({ model: 'llama3.2' });
      await engine.start();

      try {
        await engine.send('very long message');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(EngineError);
        expect((error as EngineError).category).toBe('context_overflow');
        expect((error as EngineError).message).toContain('compact');
      }
    });
  });

  describe('rate limiting', () => {
    it('classifies 429 as rate_limited', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ error: 'too many requests' }, 429),
      );
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ error: 'too many requests' }, 429),
      );
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ error: 'too many requests' }, 429),
      );

      const engine = new OllamaEngine({ model: 'llama3.2' });
      await engine.start();

      try {
        await engine.send('test');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(EngineError);
        expect((error as EngineError).category).toBe('rate_limited');
      }
    });
  });
});
