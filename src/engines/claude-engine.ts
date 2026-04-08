import { spawn, execFileSync } from "node:child_process";
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
  emptyTokenUsage,
  mergeEngineConfig,
  mergeTokenUsage,
  roundUsd,
  toNumber,
  toOptionalNumber,
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

type ClaudeUsageDelta = {
  input: number;
  output: number;
  cachedInput: number;
  cacheCreationInput5m: number;
  cacheCreationInput1h: number;
};

type ClaudeRunResult = {
  text: string;
  sessionId: string | null;
  usage?: ClaudeUsageDelta;
  totalCostUsd?: number;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class ClaudeEngine implements IEngine {
  private config: EngineConfig;
  private state: EngineState = "idle";
  private sessionId: string | null = null;
  private usage: EngineUsageSnapshot = {
    costUsd: 0,
    tokenCount: emptyTokenUsage(),
  };
  private activeProcess: ChildProcess | null = null;
  private sentAtLeastOnePrompt = false;
  private stoppingFlag = false;

  constructor(config: EngineConfig) {
    this.config = {
      ...config,
      command: config.command ?? "claude",
      args: config.args ?? [],
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    this.sessionId = config.resumeSessionId ?? null;
  }

  async start(config?: Partial<EngineConfig>): Promise<void> {
    this.state = "starting";
    this.config = mergeEngineConfig(this.config, config);
    this.config.command ??= "claude";
    this.config.args ??= [];
    this.config.timeoutMs ??= DEFAULT_TIMEOUT_MS;

    if (!this.config.model) {
      this.state = "error";
      this.usage.lastError = "Claude model is required.";
      throw new EngineError(this.usage.lastError, 'unknown');
    }

    const command = this.config.command ?? "claude";
    try {
      execFileSync(command, ["--version"], {
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...(process?.env ?? {}), ...(this.config.env ?? {}) },
      });
    } catch (error) {
      this.state = "error";
      const isNotFound = isJsonRecord(error) && error.code === "ENOENT";
      const msg = isNotFound
        ? `Claude CLI not found at '${command}'. Install claude and ensure it is on PATH.`
        : `Claude CLI validation failed: ${error instanceof Error ? error.message : String(error)}`;
      this.usage.lastError = msg;
      throw new EngineError(msg, 'unavailable', { cause: error });
    }

    if (this.config.resumeSessionId) {
      this.sessionId = this.config.resumeSessionId;
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

    if (this.activeProcess) {
      throw new EngineError("Claude engine already has a request in flight.", 'unknown');
    }

    this.state = "running";

    try {
      const result = await this.runClaude(message, onChunk);
      const turnUsage = result.usage;
      const pricing = this.resolvePricing();
      const turnCost =
        result.totalCostUsd ??
        this.calculateClaudeCost(pricing, turnUsage);

      if (turnUsage) {
        this.usage.tokenCount = mergeTokenUsage(this.usage.tokenCount, {
          input: turnUsage.input,
          output: turnUsage.output,
          cachedInput:
            turnUsage.cachedInput +
            turnUsage.cacheCreationInput5m +
            turnUsage.cacheCreationInput1h,
        });
      }

      this.usage.costUsd = roundUsd(this.usage.costUsd + turnCost);
      this.usage.lastError = undefined;
      this.usage.lastResponseAt = new Date();
      this.sessionId = result.sessionId ?? this.sessionId;
      this.sentAtLeastOnePrompt = true;
      if (!this.stoppingFlag) {
        this.state = "running";
      }

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
    // Stay in running state — session is preserved
    if (this.state !== "stopped" && this.state !== "stopping") {
      this.state = "running";
    }
  }

  async stop(): Promise<void> {
    this.state = "stopping";
    this.stoppingFlag = true;

    if (this.activeProcess) {
      const processToStop = this.activeProcess;
      this.activeProcess = null;
      await killProcessGracefully(processToStop);
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

  private async runClaude(message: string, onChunk?: (chunk: string) => void): Promise<ClaudeRunResult> {
    const command = this.config.command ?? "claude";
    const args = this.buildArgs(message);
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const env = {
      ...(process?.env ?? {}),
      ...(this.config.env ?? {}),
    };

    return await new Promise<ClaudeRunResult>((resolve, reject) => {
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let streamText = "";
      let messageSnapshot = "";
      let finalResultText = "";
      let observedSessionId = this.sessionId;
      let usageDelta: ClaudeUsageDelta | undefined;
      let totalCostUsd: number | undefined;
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
          usageDelta = this.extractUsage(event) ?? usageDelta;

          const cost = this.extractTotalCost(event);
          if (cost !== undefined) {
            totalCostUsd = cost;
          }

          const extractedText = this.extractText(event);
          if (!extractedText) {
            continue;
          }

          if (extractedText.mode === "replace") {
            if (event.type === "result") {
              finalResultText = extractedText.text;
            } else {
              messageSnapshot = extractedText.text;
            }
          } else {
            streamText += extractedText.text;
            if (onChunk) {
              try { onChunk(extractedText.text); } catch { /* non-fatal */ }
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
        reject(createSpawnError("Claude", error));
      });

      child.once("close", (code: number | null, signal: string | null) => {
        clearTimeout(timeoutHandle);
        this.activeProcess = null;

        if (stdoutBuffer.trim()) {
          stdoutBuffer += "\n";
          flushStdout();
        }

        // If we're stopping, resolve gracefully with whatever we have
        if (this.stoppingFlag) {
          const text = finalResultText || messageSnapshot || streamText.trim();
          resolve({
            text,
            sessionId: observedSessionId,
            usage: usageDelta,
            totalCostUsd,
          });
          return;
        }

        if (timedOut) {
          reject(
            new EngineError(`Claude request timed out after ${timeoutMs}ms.`, 'timeout'),
          );
          return;
        }

        if (code !== 0) {
          reject(createProcessError(stderrBuffer, code, signal, CLAUDE_PROCESS_ERROR_OPTIONS));
          return;
        }

        const text = finalResultText || messageSnapshot || streamText.trim();

        resolve({
          text,
          sessionId: observedSessionId,
          usage: usageDelta,
          totalCostUsd,
        });
      });
    });
  }

  private buildArgs(message: string): string[] {
    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      this.config.model,
      ...(this.config.args ?? []),
    ];

    if (this.sessionId && (this.sentAtLeastOnePrompt || this.config.resumeSessionId)) {
      args.push("--resume", this.sessionId);
    } else if (this.sessionId) {
      args.push("--session-id", this.sessionId);
    }

    args.push(message);

    return args;
  }

  private resolvePricing(): ModelPricing {
    const fallback =
      this.config.model.toLowerCase().includes("opus")
        ? {
            inputPer1M: 15,
            outputPer1M: 75,
            cachedInputPer1M: 1.5,
          }
        : {
            inputPer1M: 3,
            outputPer1M: 15,
            cachedInputPer1M: 0.3,
          };

    return {
      inputPer1M: this.config.pricing?.inputPer1M ?? fallback.inputPer1M,
      outputPer1M: this.config.pricing?.outputPer1M ?? fallback.outputPer1M,
      cachedInputPer1M:
        this.config.pricing?.cachedInputPer1M ?? fallback.cachedInputPer1M,
    };
  }

  private calculateClaudeCost(
    pricing: ModelPricing,
    usage?: ClaudeUsageDelta,
  ): number {
    if (!usage) {
      return 0;
    }

    const cacheWrite5mRate = pricing.inputPer1M * 1.25;
    const cacheWrite1hRate = pricing.inputPer1M * 2;
    const cost =
      (usage.input * pricing.inputPer1M +
        usage.output * pricing.outputPer1M +
        usage.cachedInput * pricing.cachedInputPer1M +
        usage.cacheCreationInput5m * cacheWrite5mRate +
        usage.cacheCreationInput1h * cacheWrite1hRate) /
      1_000_000;

    return roundUsd(cost);
  }

  private extractSessionId(event: JsonRecord): string | undefined {
    return (
      toStringValue(event.session_id) ??
      toStringValue(getNestedValue(event, ["message", "session_id"])) ??
      toStringValue(getNestedValue(event, ["result", "session_id"]))
    );
  }

  private extractTotalCost(event: JsonRecord): number | undefined {
    const value =
      event.total_cost_usd ??
      getNestedValue(event, ["message", "total_cost_usd"]) ??
      getNestedValue(event, ["result", "total_cost_usd"]);

    return toOptionalNumber(value);
  }

  private extractUsage(event: JsonRecord): ClaudeUsageDelta | undefined {
    const usageCandidate =
      getJsonRecord(event.usage) ??
      getJsonRecord(getNestedValue(event, ["message", "usage"])) ??
      getJsonRecord(getNestedValue(event, ["result", "usage"]));

    if (!usageCandidate) {
      return undefined;
    }

    const cacheCreation = getJsonRecord(usageCandidate.cache_creation);
    const cacheCreation5m =
      toNumber(cacheCreation?.ephemeral_5m_input_tokens) ||
      (toNumber(usageCandidate.cache_creation_input_tokens) > 0 &&
      !cacheCreation?.ephemeral_1h_input_tokens
        ? toNumber(usageCandidate.cache_creation_input_tokens)
        : 0);
    const cacheCreation1h = toNumber(cacheCreation?.ephemeral_1h_input_tokens);
    const cacheRead = toNumber(usageCandidate.cache_read_input_tokens);
    const input = toNumber(usageCandidate.input_tokens);
    const output = toNumber(usageCandidate.output_tokens);

    if (
      input === 0 &&
      output === 0 &&
      cacheRead === 0 &&
      cacheCreation5m === 0 &&
      cacheCreation1h === 0
    ) {
      return undefined;
    }

    return {
      input,
      output,
      cachedInput: cacheRead,
      cacheCreationInput5m: cacheCreation5m,
      cacheCreationInput1h: cacheCreation1h,
    };
  }

  private extractText(
    event: JsonRecord,
  ): { mode: "append" | "replace"; text: string } | undefined {
    if (typeof event.result === "string") {
      return { mode: "replace", text: event.result.trim() };
    }

    const message = getJsonRecord(event.message);
    const eventType = toStringValue(event.type);
    const messageRole = toStringValue(message?.role);
    const contentText = this.extractContentText(message?.content);
    if (contentText && (eventType === "assistant" || messageRole === "assistant")) {
      return { mode: "replace", text: contentText };
    }

    const delta = getJsonRecord(event.delta);
    if (typeof delta?.text === "string") {
      return { mode: "append", text: delta.text };
    }

    const contentBlock = getJsonRecord(event.content_block);
    if (typeof contentBlock?.text === "string") {
      return { mode: "append", text: contentBlock.text };
    }

    if (typeof event.text === "string") {
      return { mode: "append", text: event.text };
    }

    return undefined;
  }

  private extractContentText(content: unknown): string {
    if (typeof content === "string") {
      return content.trim();
    }

    if (!Array.isArray(content)) {
      return "";
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

    return text.trim();
  }
}

const CLAUDE_PROCESS_ERROR_OPTIONS = {
  engineLabel: "Claude",
  authRegex: /auth|login|expired|unauthorized|forbidden|credential/i,
  authMessage: "Claude authentication appears to be expired. Re-authenticate the Claude CLI.",
  authCategory: "auth_expired" as const,
};
