/**
 * Ollama Engine — local LLM via OpenAI-compatible HTTP API.
 *
 * Ollama runs locally at http://localhost:11434 and exposes an
 * OpenAI-compatible /v1/chat/completions endpoint. No API key
 * required. Cost is always $0 (local inference).
 *
 * Supports streaming (SSE) for incremental output when an onChunk
 * callback is provided, and retries with exponential backoff for
 * transient errors.
 */

import type {
  EngineConfig,
  EngineState,
  EngineStatusSnapshot,
  EngineUsageSnapshot,
  IEngine,
} from "../types.js";
import { EngineError } from "../errors.js";
import {
  buildCompactPrompt,
  emptyTokenUsage,
  mergeEngineConfig,
  mergeTokenUsage,
  toNumber,
  toStringValue,
} from "./shared.js";

type OllamaMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type JsonRecord = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 500;

export class OllamaEngine implements IEngine {
  private config: EngineConfig;
  private state: EngineState = "idle";
  private sessionId: string | null = null;
  private usage: EngineUsageSnapshot = {
    costUsd: 0,
    tokenCount: emptyTokenUsage(),
  };
  private messages: OllamaMessage[] = [];
  private activeAbortController: AbortController | null = null;

  constructor(config: EngineConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    this.sessionId = config.resumeSessionId ?? null;
  }

  async start(config?: Partial<EngineConfig>): Promise<void> {
    this.state = "starting";
    this.config = mergeEngineConfig(this.config, config);
    this.config.baseUrl ??= DEFAULT_BASE_URL;
    this.config.timeoutMs ??= DEFAULT_TIMEOUT_MS;

    if (!this.config.model) {
      this.state = "error";
      this.usage.lastError = "Ollama model is required.";
      throw new EngineError(this.usage.lastError, 'unknown');
    }

    try {
      const baseOrigin = this.config.baseUrl.replace(/\/v1\/?$/, '');
      const response = await fetch(baseOrigin, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      this.state = "error";
      const msg = `Ollama is not reachable at ${this.config.baseUrl}. Ensure Ollama is running.`;
      this.usage.lastError = msg;
      throw new EngineError(msg, 'unavailable', { cause: error });
    }

    if (!this.sessionId) {
      this.sessionId = crypto.randomUUID();
    }

    this.state = "running";
  }

  async send(message: string, onChunk?: (chunk: string) => void): Promise<string> {
    if (!message.trim()) {
      return "";
    }

    if (this.state === "idle" || this.state === "stopped") {
      await this.start();
    }

    if (this.activeAbortController) {
      throw new EngineError("Ollama engine already has a request in flight.", 'unknown');
    }

    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
    const nextMessages: OllamaMessage[] = [
      ...this.messages,
      { role: "user", content: message },
    ];

    this.activeAbortController = abortController;
    this.state = "running";

    try {
      const result = await this.sendWithRetry(nextMessages, abortController, timeoutMs, onChunk);

      this.messages = [...nextMessages, { role: "assistant", content: result.text }];

      if (result.usage) {
        this.usage.tokenCount = mergeTokenUsage(this.usage.tokenCount, result.usage);
      }

      this.usage.costUsd = 0;
      this.usage.lastError = undefined;
      this.usage.lastResponseAt = new Date();
      this.state = "running";

      return result.text;
    } catch (error) {
      const normalized = this.normalizeError(error, timeoutMs);
      const s: string = this.state;
      if (s !== "stopping" && s !== "stopped") {
        this.state = "error";
      }
      this.usage.lastError = normalized.message;
      throw normalized;
    } finally {
      clearTimeout(timeoutHandle);
      this.activeAbortController = null;
    }
  }

  async compact(summary?: string): Promise<string> {
    const compactedSummary = await this.send(buildCompactPrompt(summary));
    this.messages = [{ role: "assistant", content: compactedSummary }];
    return compactedSummary;
  }

  cancel(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
    if (this.state === "running") {
      this.state = "running";
    }
  }

  async stop(): Promise<void> {
    this.state = "stopping";

    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    this.state = "stopped";
  }

  status(): EngineStatusSnapshot {
    return {
      state: this.state,
      sessionId: this.sessionId,
      model: this.config.model,
      usage: {
        costUsd: 0,
        tokenCount: { ...this.usage.tokenCount },
        lastError: this.usage.lastError,
        lastResponseAt: this.usage.lastResponseAt,
      },
    };
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  private async sendWithRetry(
    messages: OllamaMessage[],
    abortController: AbortController,
    timeoutMs: number,
    onChunk?: (chunk: string) => void,
  ): Promise<{
    text: string;
    usage: { input: number; output: number; cachedInput: number } | undefined;
  }> {
    let lastError: EngineError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.sendOnce(messages, abortController, onChunk);
      } catch (error) {
        const engineError = error instanceof EngineError
          ? error
          : this.normalizeError(error, timeoutMs);

        if (!engineError.retriable || attempt >= MAX_RETRIES) {
          throw engineError;
        }

        lastError = engineError;
        const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), 5_000);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }

    throw lastError!;
  }

  private async sendOnce(
    messages: OllamaMessage[],
    abortController: AbortController,
    onChunk?: (chunk: string) => void,
  ): Promise<{
    text: string;
    usage: { input: number; output: number; cachedInput: number } | undefined;
  }> {
    const useStreaming = Boolean(onChunk);

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: useStreaming,
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const rawBody = await response.text();
      const payload = this.tryParseJson(rawBody);
      throw this.createHttpError(response.status, payload, rawBody);
    }

    if (useStreaming && response.body) {
      return this.consumeStream(response.body, onChunk!);
    }

    const rawBody = await response.text();
    const payload = this.tryParseJson(rawBody);

    if (!payload) {
      throw new EngineError("Ollama returned a non-JSON response.", 'transient');
    }

    const assistantContent = this.extractAssistantContent(payload);
    const usage = this.extractUsage(payload);

    return { text: assistantContent, usage };
  }

  private async consumeStream(
    body: ReadableStream<Uint8Array>,
    onChunk: (chunk: string) => void,
  ): Promise<{
    text: string;
    usage: { input: number; output: number; cachedInput: number } | undefined;
  }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';
    let usage: { input: number; output: number; cachedInput: number } | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();

          if (!line || line.startsWith(':')) {
            continue;
          }

          if (line === 'data: [DONE]') {
            continue;
          }

          if (!line.startsWith('data: ')) {
            continue;
          }

          const jsonStr = line.slice(6);
          const chunk = this.tryParseJson(jsonStr);
          if (!chunk) {
            continue;
          }

          const delta = this.extractStreamDelta(chunk);
          if (delta) {
            accumulated += delta;
            onChunk(delta);
          }

          const chunkUsage = this.extractUsage(chunk);
          if (chunkUsage) {
            usage = chunkUsage;
          }
        }
      }

      if (buffer.trim()) {
        const remaining = buffer.trim();
        if (remaining.startsWith('data: ') && remaining !== 'data: [DONE]') {
          const chunk = this.tryParseJson(remaining.slice(6));
          if (chunk) {
            const delta = this.extractStreamDelta(chunk);
            if (delta) {
              accumulated += delta;
              onChunk(delta);
            }
            const chunkUsage = this.extractUsage(chunk);
            if (chunkUsage) {
              usage = chunkUsage;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { text: accumulated.trim(), usage };
  }

  private extractStreamDelta(chunk: JsonRecord): string | undefined {
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const firstChoice = choices[0] as JsonRecord | undefined;
    if (!firstChoice || typeof firstChoice !== 'object') {
      return undefined;
    }

    const delta = firstChoice.delta as JsonRecord | undefined;
    if (!delta || typeof delta !== 'object') {
      return undefined;
    }

    const content = delta.content;
    return typeof content === 'string' ? content : undefined;
  }

  private extractAssistantContent(payload: JsonRecord): string {
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const firstChoice = choices[0] as JsonRecord | undefined;
    if (!firstChoice || typeof firstChoice !== 'object') {
      throw new EngineError("Ollama response did not include a completion choice.", 'unknown');
    }

    const message = firstChoice.message as JsonRecord | undefined;
    if (!message || typeof message !== 'object') {
      throw new EngineError("Ollama response did not include a message.", 'unknown');
    }

    const content = message.content;
    if (typeof content === 'string') {
      return content.trim();
    }

    return '';
  }

  private extractUsage(
    payload: JsonRecord,
  ): { input: number; output: number; cachedInput: number } | undefined {
    const usage = payload.usage as JsonRecord | undefined;
    if (!usage || typeof usage !== 'object') {
      return undefined;
    }

    const input = toNumber(usage.prompt_tokens);
    const output = toNumber(usage.completion_tokens);
    if (input === 0 && output === 0) {
      return undefined;
    }

    return { input, output, cachedInput: 0 };
  }

  private createHttpError(
    status: number,
    payload: JsonRecord | undefined,
    rawBody: string,
  ): EngineError {
    const message =
      toStringValue(payload?.error as string | undefined) ??
      toStringValue((payload?.error as JsonRecord | undefined)?.message as string | undefined) ??
      (rawBody.trim() || `HTTP ${status}`);

    if (status === 404) {
      return new EngineError(
        `Ollama model "${this.config.model}" not found. Pull it with: ollama pull ${this.config.model}`,
        'unavailable',
        { httpStatus: status },
      );
    }

    if (status === 400 && /context|too long|token/i.test(message)) {
      return new EngineError(
        `Ollama context overflow for model "${this.config.model}". Use compact to reduce context size.`,
        'context_overflow',
        { httpStatus: status },
      );
    }

    if (status >= 500) {
      return new EngineError(
        `Ollama server error (${status}): ${message}`,
        'transient',
        { httpStatus: status, retriable: true },
      );
    }

    if (status === 429) {
      return new EngineError(
        `Ollama rate limited (${status}): ${message}`,
        'rate_limited',
        { httpStatus: status, retriable: true },
      );
    }

    return new EngineError(
      `Ollama request failed (${status}): ${message}`,
      'unknown',
      { httpStatus: status },
    );
  }

  private normalizeError(error: unknown, timeoutMs: number): EngineError {
    if (error instanceof EngineError) {
      return error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      if (this.state === "stopping" || this.state === "stopped") {
        return new EngineError("Ollama request was stopped.", 'cancelled');
      }
      return new EngineError(`Ollama request timed out after ${timeoutMs}ms.`, 'timeout');
    }

    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      return new EngineError(
        `Ollama is not reachable at ${this.config.baseUrl}. Ensure Ollama is running.`,
        'unavailable',
        { cause: error },
      );
    }

    return new EngineError(message, 'unknown', { cause: error });
  }

  private tryParseJson(rawBody: string): JsonRecord | undefined {
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as JsonRecord;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
}
