import type {
  EngineConfig,
  EngineState,
  EngineStatusSnapshot,
  EngineUsageSnapshot,
  IEngine,
  ModelPricing,
} from "../types.js";
import {
  EngineError,
  categorizeHttpStatus,
  parseRetryAfterMs,
} from "../errors.js";
import {
  buildCompactPrompt,
  calculateLinearUsageCost,
  emptyTokenUsage,
  mergeEngineConfig,
  mergeTokenUsage,
  roundUsd,
  splitCachedInputTokens,
  toNumber,
  toOptionalNumber,
  toStringValue,
} from "./shared.js";

type GrokMessage = {
  role: "system" | "developer" | "user" | "assistant";
  content: string | Array<{ type: "text"; text: string }>;
  reasoning_content?: unknown;
};

type JsonRecord = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const USD_TICKS_PER_DOLLAR = 10_000_000_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

export class GrokEngine implements IEngine {
  private config: EngineConfig;
  private state: EngineState = "idle";
  private sessionId: string | null = null;
  private usage: EngineUsageSnapshot = {
    costUsd: 0,
    tokenCount: emptyTokenUsage(),
  };
  private messages: GrokMessage[] = [];
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
      this.usage.lastError = "Grok model is required.";
      throw new Error(this.usage.lastError);
    }

    if (!this.resolveApiKey()) {
      this.state = "error";
      this.usage.lastError = "Missing XAI API key. Set `XAI_API_KEY` or provide `apiKey`.";
      throw new EngineError(this.usage.lastError, 'auth_expired');
    }

    if (!this.sessionId) {
      this.sessionId = this.config.resumeSessionId ?? crypto.randomUUID();
    }

    this.state = "running";
  }

  async send(message: string, _onChunk?: (chunk: string) => void): Promise<string> {
    if (!message.trim()) {
      return "";
    }

    if (this.state === "idle" || this.state === "stopped") {
      await this.start();
    }

    if (this.activeAbortController) {
      throw new Error("Grok engine already has a request in flight.");
    }

    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      this.state = "error";
      this.usage.lastError = "Missing XAI API key. Set `XAI_API_KEY` or provide `apiKey`.";
      throw new EngineError(this.usage.lastError, 'auth_expired');
    }

    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
    const nextMessages = [...this.messages, { role: "user", content: message } satisfies GrokMessage];

    this.activeAbortController = abortController;
    this.state = "running";

    try {
      const result = await this.sendWithRetry(apiKey, nextMessages, abortController, timeoutMs);

      this.messages = [...nextMessages, result.assistantMessage];

      if (result.usage) {
        this.usage.tokenCount = mergeTokenUsage(this.usage.tokenCount, result.usage);
      }

      this.usage.costUsd = roundUsd(
        this.usage.costUsd +
          (result.usageCostUsd ?? calculateLinearUsageCost(this.resolvePricing(), result.usage)),
      );
      this.usage.lastError = undefined;
      this.usage.lastResponseAt = new Date();
      this.state = "running";

      return result.text;
    } catch (error) {
      const normalizedError = this.normalizeError(error, timeoutMs);
      const s: string = this.state;
      if (s !== "stopping" && s !== "stopped") {
        this.state = "error";
      }
      this.usage.lastError = normalizedError.message;
      throw normalizedError;
    } finally {
      clearTimeout(timeoutHandle);
      this.activeAbortController = null;
    }
  }

  async compact(summary?: string): Promise<string> {
    const compactedSummary = await this.send(buildCompactPrompt(summary));
    this.messages = [
      {
        role: 'assistant',
        content: compactedSummary,
      },
    ];

    return compactedSummary;
  }

  cancel(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
    if (this.state === "running") {
      this.state = "running"; // stay running — session is not destroyed
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
        costUsd: this.usage.costUsd,
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
    apiKey: string,
    messages: GrokMessage[],
    abortController: AbortController,
    timeoutMs: number,
  ): Promise<{
    text: string;
    assistantMessage: GrokMessage;
    usage: ReturnType<GrokEngine['extractUsage']>;
    usageCostUsd: number | undefined;
  }> {
    let lastError: EngineError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.sendOnce(apiKey, messages, abortController);
      } catch (error) {
        const engineError = error instanceof EngineError
          ? error
          : this.normalizeError(error, timeoutMs);

        if (!engineError.retriable || attempt >= MAX_RETRIES) {
          throw engineError;
        }

        lastError = engineError;
        const backoffMs = engineError.retryAfterMs
          ?? Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), 10_000);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }

    throw lastError!;
  }

  private async sendOnce(
    apiKey: string,
    messages: GrokMessage[],
    abortController: AbortController,
  ): Promise<{
    text: string;
    assistantMessage: GrokMessage;
    usage: ReturnType<GrokEngine['extractUsage']>;
    usageCostUsd: number | undefined;
  }> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "x-grok-conv-id": this.sessionId ?? crypto.randomUUID(),
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: false,
      }),
      signal: abortController.signal,
    });

    const rawBody = await response.text();
    const payload = this.tryParseJson(rawBody);

    if (!response.ok) {
      throw this.createHttpError(response.status, payload, rawBody, response);
    }

    if (!payload) {
      throw new EngineError("Grok API returned a non-JSON response.", 'transient');
    }

    const assistantMessage = this.extractAssistantMessage(payload);
    const text = this.extractMessageText(assistantMessage.content);
    const usage = this.extractUsage(payload);
    const usageCostUsd = this.extractUsageCost(payload);

    return { text, assistantMessage, usage, usageCostUsd };
  }

  private resolveApiKey(): string | undefined {
    return (
      this.config.apiKey ??
      this.config.env?.XAI_API_KEY ??
      (typeof process !== 'undefined' ? process.env?.XAI_API_KEY : undefined)
    );
  }

  private resolvePricing(): ModelPricing {
    const model = this.config.model.toLowerCase();

    if (model.includes("grok-4-1-fast") || model.includes("grok-4-fast")) {
      return {
        inputPer1M: this.config.pricing?.inputPer1M ?? 0.2,
        outputPer1M: this.config.pricing?.outputPer1M ?? 0.5,
        cachedInputPer1M: this.config.pricing?.cachedInputPer1M ?? 0.05,
      };
    }

    // xAI does not expose a stable static pricing line for the `grok-4.20`
    // alias in the text we can reliably scrape, so we fall back to flagship
    // Grok 4 rates unless the API returns exact cost ticks or the caller overrides it.
    return {
      inputPer1M: this.config.pricing?.inputPer1M ?? 3,
      outputPer1M: this.config.pricing?.outputPer1M ?? 15,
      cachedInputPer1M: this.config.pricing?.cachedInputPer1M ?? 0.75,
    };
  }

  private tryParseJson(rawBody: string): JsonRecord | undefined {
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (this.isJsonRecord(parsed)) {
        return parsed;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private extractAssistantMessage(payload: JsonRecord): GrokMessage {
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const firstChoice = choices[0];

    if (!this.isJsonRecord(firstChoice)) {
      throw new Error("Grok API response did not include a completion choice.");
    }

    const message = this.getJsonRecord(firstChoice.message);
    if (!message) {
      throw new Error("Grok API response did not include a message payload.");
    }

    const content = this.normalizeMessageContent(message.content);

    return {
      role: "assistant",
      content,
      reasoning_content: message.reasoning_content,
    };
  }

  private normalizeMessageContent(
    content: unknown,
  ): string | Array<{ type: "text"; text: string }> {
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    return content
      .map((item) => {
        if (!this.isJsonRecord(item)) {
          return undefined;
        }

        const text = toStringValue(item.text);
        if (!text) {
          return undefined;
        }

        return {
          type: "text" as const,
          text,
        };
      })
      .filter((item): item is { type: "text"; text: string } => Boolean(item));
  }

  private extractMessageText(
    content: string | Array<{ type: "text"; text: string }>,
  ): string {
    if (typeof content === "string") {
      return content.trim();
    }

    return content.map((item) => item.text).join("").trim();
  }

  private extractUsage(
    payload: JsonRecord,
  ): { input: number; output: number; cachedInput: number } | undefined {
    const usage = this.getJsonRecord(payload.usage);
    if (!usage) {
      return undefined;
    }

    const totalInputTokens =
      toNumber(usage.prompt_tokens) ||
      toNumber(usage.input_tokens) ||
      toNumber(this.getNestedValue(usage, ["prompt_tokens_details", "text_tokens"])) ||
      toNumber(this.getNestedValue(usage, ["input_tokens_details", "text_tokens"]));
    const cachedInputTokens =
      toNumber(this.getNestedValue(usage, ["prompt_tokens_details", "cached_tokens"])) ||
      toNumber(this.getNestedValue(usage, ["input_tokens_details", "cached_tokens"]));
    const outputTokens =
      toNumber(usage.completion_tokens) ||
      toNumber(usage.output_tokens) ||
      toNumber(usage.reasoning_tokens) ||
      toNumber(
        this.getNestedValue(usage, ["completion_tokens_details", "reasoning_tokens"]),
      ) ||
      toNumber(
        this.getNestedValue(usage, ["output_tokens_details", "reasoning_tokens"]),
      );

    if (totalInputTokens === 0 && cachedInputTokens === 0 && outputTokens === 0) {
      return undefined;
    }

    const splitUsage = splitCachedInputTokens(totalInputTokens, cachedInputTokens);

    return {
      input: splitUsage.input,
      output: outputTokens,
      cachedInput: splitUsage.cachedInput,
    };
  }

  private extractUsageCost(payload: JsonRecord): number | undefined {
    const usage = this.getJsonRecord(payload.usage);
    if (!usage) {
      return undefined;
    }

    const usdTicks = toOptionalNumber(usage.cost_in_usd_ticks);
    if (usdTicks !== undefined) {
      return roundUsd(usdTicks / USD_TICKS_PER_DOLLAR);
    }

    return (
      toOptionalNumber(usage.cost_usd) ??
      toOptionalNumber(usage.total_cost_usd) ??
      toOptionalNumber(payload.cost_usd)
    );
  }

  private createHttpError(
    status: number,
    payload: JsonRecord | undefined,
    rawBody: string,
    response?: { headers?: { get?(name: string): string | null } },
  ): EngineError {
    const fallbackMessage = rawBody.trim() || `HTTP ${status}`;
    const message =
      toStringValue(payload?.error) ??
      toStringValue(this.getNestedValue(payload, ["error", "message"])) ??
      fallbackMessage;

    const category = categorizeHttpStatus(status);
    const retryAfterMs = parseRetryAfterMs(response?.headers?.get?.("retry-after"));

    if (category === 'auth_expired') {
      return new EngineError(
        "Grok authentication appears to be invalid or expired. Check `XAI_API_KEY`.",
        'auth_expired',
        { httpStatus: status },
      );
    }

    return new EngineError(
      `Grok API request failed (${status}): ${message}`,
      category,
      { httpStatus: status, retryAfterMs },
    );
  }

  private normalizeError(error: unknown, timeoutMs: number): EngineError {
    if (error instanceof EngineError) {
      return error;
    }

    if (
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      if (this.state === "stopping" || this.state === "stopped") {
        return new EngineError("Grok request was stopped.", 'cancelled');
      }

      return new EngineError(`Grok request timed out after ${timeoutMs}ms.`, 'timeout');
    }

    const message = error instanceof Error ? error.message : String(error);
    return new EngineError(message, 'unknown', { cause: error });
  }

  private getNestedValue(record: JsonRecord | undefined, path: string[]): unknown {
    let current: unknown = record;

    for (const segment of path) {
      if (!this.isJsonRecord(current)) {
        return undefined;
      }

      current = current[segment];
    }

    return current;
  }

  private getJsonRecord(value: unknown): JsonRecord | undefined {
    return this.isJsonRecord(value) ? value : undefined;
  }

  private isJsonRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
