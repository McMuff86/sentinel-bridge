import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type {
  EngineConfig,
  EngineState,
  EngineStatusSnapshot,
  EngineUsageSnapshot,
  IEngine,
  ModelPricing,
} from "../types.js";
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
import { EngineError } from "../errors.js";
import {
  type JsonRecord,
  parseJsonLine,
  getNestedValue,
  getJsonRecord,
  chunkToString,
  isJsonRecord,
  createSpawnError,
  createProcessError,
  killProcessGracefully,
} from "./cli-utils.js";

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

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class CodexEngine implements IEngine {
  private config: EngineConfig;
  private state: EngineState = "idle";
  private sessionId: string | null = null;
  private usage: EngineUsageSnapshot = {
    costUsd: 0,
    tokenCount: emptyTokenUsage(),
  };
  private activeProcess: ChildProcess | null = null;
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
      throw new EngineError(this.usage.lastError, 'unknown');
    }

    this.authMethod = await this.detectAuth();
    if (this.authMethod === "none") {
      this.state = "error";
      this.usage.lastError =
        "Codex authentication is unavailable. Configure `apiKey` or sign in with `codex auth login`.";
      throw new EngineError(this.usage.lastError, 'auth_expired');
    }

    this.usage.lastError = undefined;
    this.sessionId = this.config.resumeSessionId ?? this.sessionId;
    this.state = "running";
  }

  async send(message: string, onChunk?: (chunk: string) => void): Promise<string> {
    if (!message.trim()) {
      return "";
    }

    if (this.state === "idle" || this.state === "stopped") {
      await this.start();
    }

    if (this.activeProcess) {
      throw new EngineError("Codex engine already has a request in flight.", 'unknown');
    }

    try {
      const result = await this.runCodex(message, onChunk);
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
      await killProcessGracefully(processToStop);
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

  private async runCodex(message: string, onChunk?: (chunk: string) => void): Promise<CodexRunResult> {
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
      const agentMessages: string[] = [];
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

          const event = parseJsonLine(line);
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
            agentMessages.push(agentMessage);
            if (onChunk) {
              try { onChunk(agentMessage); } catch { /* non-fatal */ }
            }
          }
        }
      };

      child.stdout.on("data", (chunk: unknown) => {
        stdoutBuffer += chunkToString(chunk);
        flushStdout();
      });

      child.stderr.on("data", (chunk: unknown) => {
        stderrBuffer += chunkToString(chunk);
      });

      child.once("error", (error: unknown) => {
        clearTimeout(timeoutHandle);
        this.activeProcess = null;
        reject(createSpawnError("Codex", error));
      });

      child.once("close", (code: number | null, signal: string | null) => {
        clearTimeout(timeoutHandle);
        this.activeProcess = null;

        if (stdoutBuffer.trim()) {
          stdoutBuffer += "\n";
          flushStdout();
        }

        if (timedOut) {
          reject(new EngineError(`Codex request timed out after ${timeoutMs}ms.`, 'timeout'));
          return;
        }

        if (runtimeError) {
          reject(new EngineError(runtimeError, 'unknown'));
          return;
        }

        if (code !== 0) {
          reject(createProcessError(stderrBuffer, code, signal, CODEX_PROCESS_ERROR_OPTIONS));
          return;
        }

        resolve({
          text: agentMessages.join('\n\n').trim(),
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
        stdoutBuffer += chunkToString(chunk);
      });

      child.stderr.on("data", (chunk: unknown) => {
        stderrBuffer += chunkToString(chunk);
      });

      child.once("error", (error: unknown) => {
        if (isJsonRecord(error) && error.code === "ENOENT") {
          settle((_, rejectValue) => rejectValue(createSpawnError("Codex", error)));
          return;
        }

        settle((resolveValue) => resolveValue(apiKey ? "apiKey" : "none"));
      });

      child.once("close", (code: number | null) => {
        const rawOutput = [stdoutBuffer, stderrBuffer]
          .filter((part) => part.trim().length > 0)
          .join("\n")
          .trim();

        if (this.detectSubscriptionAuth(rawOutput, code)) {
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

  private extractSessionId(event: JsonRecord): string | undefined {
    return (
      toStringValue(event.thread_id) ??
      toStringValue(event.session_id) ??
      toStringValue(getNestedValue(event, ["thread", "id"]))
    );
  }

  private extractAgentMessage(event: JsonRecord): string | undefined {
    if (toStringValue(event.type) === "agent_message") {
      return toStringValue(event.text) ?? this.extractContentText(event.content);
    }

    const item = getJsonRecord(event.item);
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
      getJsonRecord(event.usage) ??
      getJsonRecord(getNestedValue(event, ["turn", "usage"]));

    if (!usageRecord) {
      return undefined;
    }

    const outputTokens =
      toNumber(usageRecord.output_tokens) ||
      toNumber(usageRecord.completion_tokens) ||
      toNumber(
        getNestedValue(usageRecord, ["output_tokens_details", "reasoning_tokens"]),
      ) ||
      toNumber(
        getNestedValue(usageRecord, ["completion_tokens_details", "reasoning_tokens"]),
      );
    const inputTokens =
      toNumber(usageRecord.input_tokens) || toNumber(usageRecord.prompt_tokens);
    const cachedInputTokens =
      toNumber(usageRecord.cached_input_tokens) ||
      toNumber(
        getNestedValue(usageRecord, ["input_tokens_details", "cached_tokens"]),
      ) ||
      toNumber(
        getNestedValue(usageRecord, ["prompt_tokens_details", "cached_tokens"]),
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
        toStringValue(getNestedValue(event, ["error", "message"])) ??
        "Codex turn failed."
      );
    }

    if (type === "error") {
      return (
        toStringValue(event.message) ??
        toStringValue(getNestedValue(event, ["error", "message"])) ??
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
        if (!isJsonRecord(item)) {
          return "";
        }

        return typeof item.text === "string" ? item.text : "";
      })
      .filter(Boolean)
      .join("");

    return text.trim() || undefined;
  }

  private detectSubscriptionAuth(output: string, code: number | null): boolean {
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
}

const CODEX_PROCESS_ERROR_OPTIONS = {
  engineLabel: "Codex",
  authRegex: /auth|login|api key|credential|unauthorized|forbidden/i,
  authMessage: "Codex authentication appears to be unavailable or expired. Configure `apiKey`/`CODEX_API_KEY` or refresh the CLI login.",
  authCategory: "auth_expired" as const,
};
