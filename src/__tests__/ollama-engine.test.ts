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
    // start() health check
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));
    // send() chat completion
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
    expect(engine.status().usage.costUsd).toBe(0); // always free
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

    // Don't resolve the send fetch — simulate in-flight
    let rejectFn!: (reason: unknown) => void;
    fetchSpy.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectFn = reject; }),
    );

    const sendPromise = engine.send('test').catch((e) => e);
    engine.cancel();

    // The abort should cause the fetch to reject
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

    // Verify second call includes history
    const secondCallBody = JSON.parse(
      (fetchSpy.mock.calls[2]![1] as { body: string }).body,
    );
    expect(secondCallBody.messages).toHaveLength(3); // user1, assistant1, user2
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
});
