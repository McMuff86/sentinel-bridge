import { spawn } from "node:child_process";

import type {
  EngineConfig,
  EngineState,
  EngineStatusSnapshot,
  EngineUsageSnapshot,
  IEngine,
  ModelPricing,
} from "../types.js";
import { EngineError } from "../errors.js";
import {
  buildCompactPrompt,
  calculateLinearUsageCost,
  emptyTokenUsage,
  mergeEngineConfig,
  mergeTokenUsage,
  roundUsd,
  splitCachedInputTokens,
  toNumber,
  toStringValue,
} from "./shared.js";

type CodexAuthMethod = "subscription" | "apiKey" | "none";

interface CodexEngineStatusSnapshot extends EngineStatusSnapshot {
  authMethod: CodexAuthMethod;
}

type CodexRunResult = {
  text: string;
  sessionId: string | null;
  usage?: {
    input: number;
    output: number;
    cachedInput: number;
  };
};

type JsonRecord = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class CodexEngine implements IEngine {
  private config: EngineConfig;
  private state: EngineState = "idle";
  private sessionId: string | null = null;
  private usage: EngineUsageSnapshot = {
    costUsd: 0,
    tokenCount: emptyTokenUsage(),
  };
  private activeProcess: any = null;
  private sentAtLeastOnePrompt = false;
  private authMethod: CodexAuthMethod = "none";

  constructor(config: EngineConfig) {
    this.config = {
      ...config,
      command: config.command ?? "codex",
      args: config.args ?? [],
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    this.sessionId = config.resumeSessionId ?? null;
  }

  async start(config?: Partial<EngineConfig>): Promise<void> {
    this.state = "starting";
    this.config = mergeEngineConfig(this.config, config);
    this.config.command ??= "codex";
    this.config.args ??= [];
    this.config.timeoutMs ??= DEFAULT_TIMEOUT_MS;

    if (!this.config.model) {
      this.state = "error";
      this.usage.lastError = "Codex model is required.";
      throw new Error(this.usage.lastError);
    }

    this.authMethod = await this.detectAuth();
    if (this.authMethod === "none") {
      this.state = "error";
      this.usage.lastError =
        "Codex authentication is unavailable. Configure `apiKey` or sign in with `codex auth login`.";
      throw new Error(this.usage.lastError);
    }

    this.usage.lastError = undefined;
    this.sessionId = this.config.resumeSessionId ?? this.sessionId;
    this.state = "running";
  }

  async send(message: string): Promise<string> {
    if (!message.trim()) {
      return "";
    }

    if (this.state === "idle" || this.state === "stopped") {
      await this.start();
    }

    if (this.activeProcess) {
      throw new Error("Codex engine already has a request in flight.");
    }

    try {
      const result = await this.runCodex(message);
      const pricing = this.resolvePricing();

      if (result.usage) {
        this.usage.tokenCount = mergeTokenUsage(this.usage.tokenCount, result.usage);
      }

      this.usage.costUsd = roundUsd(
        this.usage.costUsd + calculateLinearUsageCost(pricing, result.usage),
      );
      this.usage.lastError = undefined;
      this.usage.lastResponseAt = new Date();
      this.sessionId = result.sessionId ?? this.sessionId;
      this.sentAtLeastOnePrompt = true;
      this.state = "running";

      return result.text;
    } catch (error) {
      this.state = "error";
      this.usage.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async compact(summary?: string): Promise<string> {
    return this.send(buildCompactPrompt(summary));
  }

  cancel(): void {
    if (this.activeProcess) {
      this.activeProcess.kill("SIGTERM");
      this.activeProcess = null;
    }
    if (this.state !== "stopped" && this.state !== "stopping") {
      this.state = "running";
    }
  }

  async stop(): Promise<void> {
    this.state = "stopping";

    if (this.activeProcess) {
      const processToStop = this.activeProcess;
      this.activeProcess = null;

      processToStop.kill("SIGTERM");

      await new Promise<void>((resolve) => {
        const forceKillTimer = setTimeout(() => {
          processToStop.kill("SIGKILL");
          resolve();
        }, 1_000);

        processToStop.once("close", () => {
          clearTimeout(forceKillTimer);
          resolve();
        });
      });
    }

    this.state = "stopped";
  }

  status(): CodexEngineStatusSnapshot {
    return {
      state: this.state,
      sessionId: this.sessionId,
      model: this.config.model,
      authMethod: this.authMethod,
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

  private async runCodex(message: string): Promise<CodexRunResult> {
    const command = this.config.command ?? "codex";
    const args = this.buildArgs(message);
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const apiKey = this.resolveApiKey();
    const env = {
      ...(process?.env ?? {}),
      ...(this.config.env ?? {}),
    } as Record<string, string | undefined>;

    if (this.authMethod === "subscription") {
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
    }

    if (this.authMethod === "apiKey" && apiKey) {
      env.OPENAI_API_KEY = apiKey;
      env.CODEX_API_KEY = apiKey;
    }

    return await new Promise<CodexRunResult>((resolve, reject) => {
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let lastAgentMessage = "";
      let observedSessionId = this.sessionId;
      let usage:
        | {
            input: number;
            output: number;
            cachedInput: number;
          }
        | undefined;
      let runtimeError: string | undefined;
      let timedOut = false;

      const child = spawn(command, args, {
        cwd: this.config.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.activeProcess = child;

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (this.activeProcess === child) {
            child.kill("SIGKILL");
          }
        }, 1_000);
      }, timeoutMs);

      const flushStdout = (): void => {
        const lines = stdoutBuffer.split(/\r?\n/u);
        stdoutBuffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) {
            continue;
          }

          const event = this.parseJsonLine(line);
          if (!event) {
            continue;
          }

          observedSessionId = this.extractSessionId(event) ?? observedSessionId;
          usage = this.extractUsage(event) ?? usage;

          const errorText = this.extractRuntimeError(event);
          if (errorText) {
            runtimeError = errorText;
          }

          const agentMessage = this.extractAgentMessage(event);
          if (agentMessage) {
            lastAgentMessage = agentMessage;
          }
        }
      };

      child.stdout.on("data", (chunk: unknown) => {
        stdoutBuffer += this.chunkToString(chunk);
        flushStdout();
      });

      child.stderr.on("data", (chunk: unknown) => {
        stderrBuffer += this.chunkToString(chunk);
      });

      child.once("error", (error: unknown) => {
        clearTimeout(timeoutHandle);
        this.activeProcess = null;
        reject(this.createSpawnError(error));
      });

      child.once("close", (code: number | null, signal: string | null) => {
        clearTimeout(timeoutHandle);
        this.activeProcess = null;

        if (stdoutBuffer.trim()) {
          stdoutBuffer += "\n";
          flushStdout();
        }

        if (timedOut) {
          reject(new Error(`Codex request timed out after ${timeoutMs}ms.`));
          return;
        }

        if (runtimeError) {
          reject(new Error(runtimeError));
          return;
        }

        if (code !== 0) {
          reject(this.createProcessError(stderrBuffer, code, signal));
          return;
        }

        resolve({
          text: lastAgentMessage.trim(),
          sessionId: observedSessionId,
          usage,
        });
      });
    });
  }

  private buildArgs(message: string): string[] {
    const baseArgs = [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--model",
      this.config.model,
      ...(this.config.args ?? []),
    ];

    if (this.sessionId && (this.sentAtLeastOnePrompt || this.config.resumeSessionId)) {
      return [...baseArgs, "resume", this.sessionId, message];
    }

    return [...baseArgs, message];
  }

  private async detectAuth(): Promise<CodexAuthMethod> {
    const command = this.config.command ?? "codex";
    const apiKey = this.resolveApiKey();
    const env = {
      ...(process?.env ?? {}),
      ...(this.config.env ?? {}),
    };

    return await new Promise<CodexAuthMethod>((resolve, reject) => {
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let settled = false;

      const settle = (
        handler: (resolveValue: (value: CodexAuthMethod) => void, rejectValue: (error: Error) => void) => void,
      ): void => {
        if (settled) {
          return;
        }

        settled = true;
        handler(resolve, reject);
      };

      const child = spawn(command, ["login", "status"], {
        cwd: this.config.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk: unknown) => {
        stdoutBuffer += this.chunkToString(chunk);
      });

      child.stderr.on("data", (chunk: unknown) => {
        stderrBuffer += this.chunkToString(chunk);
      });

      child.once("error", (error: unknown) => {
        if (this.isJsonRecord(error) && error.code === "ENOENT") {
          settle((_, rejectValue) => rejectValue(this.createSpawnError(error)));
          return;
        }

        settle((resolveValue) => resolveValue(apiKey ? "apiKey" : "none"));
      });

      child.once("close", (code: number | null) => {
        const rawOutput = [stdoutBuffer, stderrBuffer]
          .filter((part) => part.trim().length > 0)
          .join("\n")
          .trim();

        if (this.hasSubscriptionAuth(rawOutput, code)) {
          settle((resolveValue) => resolveValue("subscription"));
          return;
        }

        settle((resolveValue) => resolveValue(apiKey ? "apiKey" : "none"));
      });
    });
  }

  private resolvePricing(): ModelPricing {
    const model = this.config.model.toLowerCase();
    const fallback = model.includes("gpt-5.4")
      ? {
          inputPer1M: 2.5,
          outputPer1M: 15,
          cachedInputPer1M: 0.25,
        }
      : {
          inputPer1M: 1.25,
          outputPer1M: 10,
          cachedInputPer1M: 0.125,
        };

    return {
      inputPer1M: this.config.pricing?.inputPer1M ?? fallback.inputPer1M,
      outputPer1M: this.config.pricing?.outputPer1M ?? fallback.outputPer1M,
      cachedInputPer1M:
        this.config.pricing?.cachedInputPer1M ?? fallback.cachedInputPer1M,
    };
  }

  private parseJsonLine(line: string): JsonRecord | undefined {
    try {
      const parsed = JSON.parse(line) as unknown;
      return this.isJsonRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private extractSessionId(event: JsonRecord): string | undefined {
    return (
      toStringValue(event.thread_id) ??
      toStringValue(event.session_id) ??
      toStringValue(this.getNestedValue(event, ["thread", "id"]))
    );
  }

  private extractAgentMessage(event: JsonRecord): string | undefined {
    if (toStringValue(event.type) === "agent_message") {
      return toStringValue(event.text) ?? this.extractContentText(event.content);
    }

    const item = this.getJsonRecord(event.item);
    const itemType = toStringValue(item?.type);

    if (itemType !== "agent_message") {
      return undefined;
    }

    const directText = toStringValue(item?.text);
    if (directText) {
      return directText;
    }

    return this.extractContentText(item?.content);
  }

  private extractUsage(
    event: JsonRecord,
  ): { input: number; output: number; cachedInput: number } | undefined {
    const usageRecord =
      this.getJsonRecord(event.usage) ??
      this.getJsonRecord(this.getNestedValue(event, ["turn", "usage"]));

    if (!usageRecord) {
      return undefined;
    }

    const outputTokens =
      toNumber(usageRecord.output_tokens) ||
      toNumber(usageRecord.completion_tokens) ||
      toNumber(
        this.getNestedValue(usageRecord, ["output_tokens_details", "reasoning_tokens"]),
      ) ||
      toNumber(
        this.getNestedValue(usageRecord, ["completion_tokens_details", "reasoning_tokens"]),
      );
    const inputTokens =
      toNumber(usageRecord.input_tokens) || toNumber(usageRecord.prompt_tokens);
    const cachedInputTokens =
      toNumber(usageRecord.cached_input_tokens) ||
      toNumber(
        this.getNestedValue(usageRecord, ["input_tokens_details", "cached_tokens"]),
      ) ||
      toNumber(
        this.getNestedValue(usageRecord, ["prompt_tokens_details", "cached_tokens"]),
      );

    if (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === 0) {
      return undefined;
    }

    const splitUsage = splitCachedInputTokens(inputTokens, cachedInputTokens);

    return {
      input: splitUsage.input,
      output: outputTokens,
      cachedInput: splitUsage.cachedInput,
    };
  }

  private extractRuntimeError(event: JsonRecord): string | undefined {
    const type = toStringValue(event.type);

    if (type === "turn.failed") {
      return (
        toStringValue(event.message) ??
        toStringValue(this.getNestedValue(event, ["error", "message"])) ??
        "Codex turn failed."
      );
    }

    if (type === "error") {
      return (
        toStringValue(event.message) ??
        toStringValue(this.getNestedValue(event, ["error", "message"])) ??
        "Codex reported an error."
      );
    }

    return undefined;
  }

  private extractContentText(content: unknown): string | undefined {
    if (!Array.isArray(content)) {
      return undefined;
    }

    const text = content
      .map((item) => {
        if (!this.isJsonRecord(item)) {
          return "";
        }

        return typeof item.text === "string" ? item.text : "";
      })
      .filter(Boolean)
      .join("");

    return text.trim() || undefined;
  }

  private createSpawnError(error: unknown): EngineError {
    if (this.isJsonRecord(error) && error.code === "ENOENT") {
      return new EngineError(
        "Codex CLI not found. Install `codex` and ensure it is available on PATH.",
        'unavailable',
      );
    }

    const message = error instanceof Error ? error.message : "Codex process failed to start.";
    return new EngineError(message || "Codex process failed to start.", 'unknown', { cause: error });
  }

  private createProcessError(
    stderr: string,
    code: number | null,
    signal: string | null,
  ): EngineError {
    const trimmed = stderr.trim();

    if (/auth|login|api key|credential|unauthorized|forbidden/i.test(trimmed)) {
      return new EngineError(
        "Codex authentication appears to be unavailable or expired. Configure `apiKey`/`CODEX_API_KEY` or refresh the CLI login.",
        'auth_expired',
      );
    }

    const detail = trimmed || `exit code ${code ?? "unknown"} signal ${signal ?? "none"}`;
    return new EngineError(`Codex command failed: ${detail}`, 'unknown');
  }

  private getNestedValue(record: JsonRecord, path: string[]): unknown {
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

  private hasSubscriptionAuth(output: string, code: number | null): boolean {
    if (code !== 0) {
      return false;
    }

    const normalized = output.toLowerCase();
    if (!normalized) {
      return false;
    }

    if (
      /not logged in|not authenticated|unauthenticated|signed out|login required|no active subscription|expired/i.test(
        normalized,
      )
    ) {
      return false;
    }

    if (/api key/i.test(normalized) && !/chatgpt|subscription|plan|plus|pro|team|enterprise/i.test(normalized)) {
      return false;
    }

    return /logged in|authenticated|signed in|chatgpt|subscription|plan|plus|pro|team|enterprise/i.test(
      normalized,
    );
  }

  private resolveApiKey(): string | undefined {
    return (
      this.config.apiKey ??
      this.config.env?.CODEX_API_KEY ??
      this.config.env?.OPENAI_API_KEY ??
      (typeof process !== "undefined"
        ? process.env?.CODEX_API_KEY ?? process.env?.OPENAI_API_KEY
        : undefined)
    );
  }

  private chunkToString(chunk: unknown): string {
    if (typeof chunk === "string") {
      return chunk;
    }

    if (chunk instanceof Uint8Array) {
      return new TextDecoder().decode(chunk);
    }

    return String(chunk);
  }

  private isJsonRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
