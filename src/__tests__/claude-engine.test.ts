import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaudeEngine } from "../engines/claude-engine.js";
import type { EngineConfig } from "../types.js";
import * as child_process from "node:child_process";

// Mock child_process
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return {
    ...actual,
    execFileSync: vi.fn(),
    spawn: vi.fn(),
  };
});

const mockedExecFileSync = vi.mocked(child_process.execFileSync);
const mockedSpawn = vi.mocked(child_process.spawn);

function baseConfig(overrides?: Partial<EngineConfig>): EngineConfig {
  return {
    model: "claude-sonnet-4-20250514",
    ...overrides,
  };
}

function makeChildProcess() {
  const events: Record<string, Function[]> = {};
  const child = {
    stdout: {
      on: vi.fn((event: string, cb: Function) => {
        events[`stdout:${event}`] = events[`stdout:${event}`] || [];
        events[`stdout:${event}`]!.push(cb);
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: Function) => {
        events[`stderr:${event}`] = events[`stderr:${event}`] || [];
        events[`stderr:${event}`]!.push(cb);
      }),
    },
    once: vi.fn((event: string, cb: Function) => {
      events[event] = events[event] || [];
      events[event]!.push(cb);
    }),
    kill: vi.fn(),
    emit(event: string, ...args: unknown[]) {
      for (const cb of events[event] || []) cb(...args);
    },
    emitStdout(data: string) {
      for (const cb of events["stdout:data"] || []) cb(Buffer.from(data));
    },
    emitStderr(data: string) {
      for (const cb of events["stderr:data"] || []) cb(Buffer.from(data));
    },
  };
  return child;
}

/**
 * Helper: create a spawn mock that auto-emits events after listeners are wired up.
 * Uses setTimeout(0) to let the async machinery settle.
 */
function spawnWithAutoEmit(
  child: ReturnType<typeof makeChildProcess>,
  emitter: (child: ReturnType<typeof makeChildProcess>) => void,
) {
  mockedSpawn.mockImplementation((() => {
    setTimeout(() => emitter(child), 0);
    return child;
  }) as any);
}

describe("ClaudeEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecFileSync.mockReturnValue(Buffer.from("claude 1.0.0\n"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("sets default state to idle", () => {
      const engine = new ClaudeEngine(baseConfig());
      const status = engine.status();
      expect(status.state).toBe("idle");
      expect(status.model).toBe("claude-sonnet-4-20250514");
    });

    it("picks up resumeSessionId from config", () => {
      const engine = new ClaudeEngine(
        baseConfig({ resumeSessionId: "existing-session" }),
      );
      expect(engine.getSessionId()).toBe("existing-session");
    });
  });

  describe("start()", () => {
    it("validates claude CLI is available", async () => {
      const engine = new ClaudeEngine(baseConfig());
      await engine.start();
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "claude",
        ["--version"],
        expect.objectContaining({ timeout: 10_000 }),
      );
      expect(engine.status().state).toBe("running");
    });

    it("throws if model is missing", async () => {
      const engine = new ClaudeEngine({ model: "" } as EngineConfig);
      await expect(engine.start()).rejects.toThrow("Claude model is required");
      expect(engine.status().state).toBe("error");
    });

    it("throws if claude CLI is not found (ENOENT)", async () => {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      mockedExecFileSync.mockImplementation(() => {
        throw err;
      });
      const engine = new ClaudeEngine(baseConfig());
      await expect(engine.start()).rejects.toThrow("Claude CLI not found");
      expect(engine.status().state).toBe("error");
    });

    it("throws if claude CLI validation fails for other reasons", async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error("permission denied");
      });
      const engine = new ClaudeEngine(baseConfig());
      await expect(engine.start()).rejects.toThrow(
        "Claude CLI validation failed",
      );
    });

    it("uses custom command for validation", async () => {
      const engine = new ClaudeEngine(
        baseConfig({ command: "/usr/local/bin/claude" }),
      );
      await engine.start();
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "/usr/local/bin/claude",
        ["--version"],
        expect.anything(),
      );
    });

    it("generates sessionId if none provided", async () => {
      const engine = new ClaudeEngine(baseConfig());
      await engine.start();
      expect(engine.getSessionId()).toBeTruthy();
      expect(typeof engine.getSessionId()).toBe("string");
    });

    it("preserves resumeSessionId", async () => {
      const engine = new ClaudeEngine(
        baseConfig({ resumeSessionId: "my-session-123" }),
      );
      await engine.start();
      expect(engine.getSessionId()).toBe("my-session-123");
    });
  });

  describe("send()", () => {
    it("auto-starts if idle and sends successfully", async () => {
      const child = makeChildProcess();
      spawnWithAutoEmit(child, (c) => {
        c.emitStdout(
          JSON.stringify({
            type: "result",
            result: "Hello! How can I help?",
            session_id: "sess-abc",
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_read_input_tokens: 0,
            },
          }) + "\n",
        );
        c.emit("close", 0, null);
      });

      const engine = new ClaudeEngine(baseConfig());
      const result = await engine.send("hello");
      expect(result).toBe("Hello! How can I help?");
      expect(engine.getSessionId()).toBe("sess-abc");
      expect(engine.status().state).toBe("running");
    });

    it("returns empty string for blank message", async () => {
      const engine = new ClaudeEngine(baseConfig());
      const result = await engine.send("   ");
      expect(result).toBe("");
    });

    it("throws if a request is already in flight", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(baseConfig());
      await engine.start();

      // Start first send — will hang because we don't close
      const p1 = engine.send("first");

      // Second send should throw
      await expect(engine.send("second")).rejects.toThrow(
        "already has a request in flight",
      );

      // Clean up the hanging promise
      child.emit("close", 0, null);
      await p1;
    });

    it("passes --session-id on first prompt", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(baseConfig());
      await engine.start();
      const sessionId = engine.getSessionId()!;

      const sendPromise = engine.send("test");
      child.emitStdout(
        JSON.stringify({ type: "result", result: "ok" }) + "\n",
      );
      child.emit("close", 0, null);
      await sendPromise;

      const spawnArgs = mockedSpawn.mock.calls[0]![1] as string[];
      expect(spawnArgs).toContain("--session-id");
      expect(spawnArgs).toContain(sessionId);
      expect(spawnArgs).not.toContain("--resume");
    });

    it("passes --resume on subsequent prompts", async () => {
      const child1 = makeChildProcess();
      const child2 = makeChildProcess();
      mockedSpawn
        .mockReturnValueOnce(child1 as any)
        .mockReturnValueOnce(child2 as any);

      const engine = new ClaudeEngine(baseConfig());
      await engine.start();

      // First send
      const p1 = engine.send("first");
      child1.emitStdout(
        JSON.stringify({
          type: "result",
          result: "ok1",
          session_id: "s1",
        }) + "\n",
      );
      child1.emit("close", 0, null);
      await p1;

      // Second send — should use --resume
      const p2 = engine.send("second");
      child2.emitStdout(
        JSON.stringify({ type: "result", result: "ok2" }) + "\n",
      );
      child2.emit("close", 0, null);
      await p2;

      const args2 = mockedSpawn.mock.calls[1]![1] as string[];
      expect(args2).toContain("--resume");
      expect(args2).toContain("s1");
      expect(args2).not.toContain("--session-id");
    });

    it("uses --resume when resumeSessionId is provided", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(
        baseConfig({ resumeSessionId: "existing-sess" }),
      );
      await engine.start();

      const p = engine.send("continue");
      child.emitStdout(
        JSON.stringify({ type: "result", result: "continued" }) + "\n",
      );
      child.emit("close", 0, null);
      await p;

      const args = mockedSpawn.mock.calls[0]![1] as string[];
      expect(args).toContain("--resume");
      expect(args).toContain("existing-sess");
    });

    it("accumulates token usage across sends", async () => {
      const child1 = makeChildProcess();
      const child2 = makeChildProcess();
      mockedSpawn
        .mockReturnValueOnce(child1 as any)
        .mockReturnValueOnce(child2 as any);

      const engine = new ClaudeEngine(baseConfig());
      await engine.start();

      // First send
      const p1 = engine.send("msg1");
      child1.emitStdout(
        JSON.stringify({
          type: "result",
          result: "r1",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 10,
          },
        }) + "\n",
      );
      child1.emit("close", 0, null);
      await p1;

      // Second send
      const p2 = engine.send("msg2");
      child2.emitStdout(
        JSON.stringify({
          type: "result",
          result: "r2",
          usage: {
            input_tokens: 200,
            output_tokens: 100,
            cache_read_input_tokens: 20,
          },
        }) + "\n",
      );
      child2.emit("close", 0, null);
      await p2;

      const status = engine.status();
      expect(status.usage.tokenCount.input).toBe(300);
      expect(status.usage.tokenCount.output).toBe(150);
      expect(status.usage.tokenCount.cachedInput).toBe(30);
    });

    it("handles process errors gracefully", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(baseConfig());
      await engine.start();

      const p = engine.send("fail");
      child.emitStderr("something went wrong\n");
      child.emit("close", 1, null);

      await expect(p).rejects.toThrow("Claude command failed");
      expect(engine.status().state).toBe("error");
      expect(engine.status().usage.lastError).toContain(
        "something went wrong",
      );
    });

    it("detects auth errors in stderr", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(baseConfig());
      await engine.start();

      const p = engine.send("auth-fail");
      child.emitStderr("Error: unauthorized - token expired\n");
      child.emit("close", 1, null);

      await expect(p).rejects.toThrow("authentication appears to be expired");
    });

    it("handles ENOENT spawn error", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(baseConfig());
      await engine.start();

      const p = engine.send("test");
      child.emit(
        "error",
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );

      await expect(p).rejects.toThrow("Claude CLI not found");
    });

    it("handles timeout", async () => {
      vi.useFakeTimers();

      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      // Pre-start so start() validation uses our mocked execFileSync
      const engine = new ClaudeEngine(baseConfig({ timeoutMs: 5000 }));
      await engine.start();

      const p = engine.send("slow");

      vi.advanceTimersByTime(5001);
      // Simulate the process closing after timeout kill
      child.emit("close", null, "SIGTERM");

      await expect(p).rejects.toThrow("timed out");
      vi.useRealTimers();
    });

    it("extracts total_cost_usd from result", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(baseConfig());
      await engine.start();

      const p = engine.send("test");
      child.emitStdout(
        JSON.stringify({
          type: "result",
          result: "done",
          total_cost_usd: 0.0042,
          usage: {
            input_tokens: 50,
            output_tokens: 25,
            cache_read_input_tokens: 0,
          },
        }) + "\n",
      );
      child.emit("close", 0, null);
      await p;

      expect(engine.status().usage.costUsd).toBe(0.0042);
    });

    it("passes --model and --permission-mode flags", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(
        baseConfig({ model: "claude-opus-4-20250514" }),
      );
      await engine.start();

      const p = engine.send("test");
      child.emitStdout(
        JSON.stringify({ type: "result", result: "ok" }) + "\n",
      );
      child.emit("close", 0, null);
      await p;

      const args = mockedSpawn.mock.calls[0]![1] as string[];
      expect(args).toContain("-p");
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--permission-mode");
      expect(args).toContain("bypassPermissions");
      expect(args).toContain("--model");
      expect(args).toContain("claude-opus-4-20250514");
    });
  });

  describe("compact()", () => {
    it("sends a compact prompt via send()", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(baseConfig());
      await engine.start();

      const p = engine.compact("focus on auth module");
      child.emitStdout(
        JSON.stringify({
          type: "result",
          result: "Session compacted.",
        }) + "\n",
      );
      child.emit("close", 0, null);

      const result = await p;
      expect(result).toBe("Session compacted.");

      const args = mockedSpawn.mock.calls[0]![1] as string[];
      const message = args[args.length - 1]!;
      expect(message).toContain("Compact");
      expect(message).toContain("focus on auth module");
    });
  });

  describe("stop()", () => {
    it("transitions to stopped state", async () => {
      const engine = new ClaudeEngine(baseConfig());
      await engine.start();
      await engine.stop();
      expect(engine.status().state).toBe("stopped");
    });

    it("kills active process on stop", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(baseConfig());
      await engine.start();

      // Start a send to create an active process
      const p = engine.send("running");

      // Now activeProcess should be set — call stop
      const stopPromise = engine.stop();

      // Simulate process closing after SIGTERM
      child.emit("close", null, "SIGTERM");

      await stopPromise;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      // The send resolves gracefully because the engine detects stoppingFlag
      await p;
      expect(engine.status().state).toBe("stopped");
    });

    it("force-kills if SIGTERM doesn't work within 1 second", async () => {
      vi.useFakeTimers();
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(baseConfig());
      await engine.start();

      const p = engine.send("stuck");

      const stopPromise = engine.stop();

      // Don't emit close — simulate stuck process
      vi.advanceTimersByTime(1001);

      await stopPromise;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");

      vi.useRealTimers();

      // clean up
      child.emit("close", null, "SIGKILL");
      await p.catch(() => {});
    });
  });

  describe("status()", () => {
    it("returns full status snapshot", async () => {
      const engine = new ClaudeEngine(baseConfig());
      await engine.start();

      const status = engine.status();
      expect(status).toEqual(
        expect.objectContaining({
          state: "running",
          model: "claude-sonnet-4-20250514",
          usage: expect.objectContaining({
            costUsd: 0,
            tokenCount: expect.objectContaining({
              input: 0,
              output: 0,
              cachedInput: 0,
              total: 0,
            }),
          }),
        }),
      );
      expect(status.sessionId).toBeTruthy();
    });
  });

  describe("pricing", () => {
    it("uses opus pricing for opus models", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(
        baseConfig({ model: "claude-opus-4-20250514" }),
      );
      await engine.start();

      const p = engine.send("test");
      child.emitStdout(
        JSON.stringify({
          type: "result",
          result: "done",
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }) + "\n",
      );
      child.emit("close", 0, null);
      await p;

      // Opus input = $15/1M
      expect(engine.status().usage.costUsd).toBe(15);
    });

    it("uses sonnet pricing for non-opus models", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(
        baseConfig({ model: "claude-sonnet-4-20250514" }),
      );
      await engine.start();

      const p = engine.send("test");
      child.emitStdout(
        JSON.stringify({
          type: "result",
          result: "done",
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }) + "\n",
      );
      child.emit("close", 0, null);
      await p;

      // Sonnet input = $3/1M
      expect(engine.status().usage.costUsd).toBe(3);
    });

    it("respects custom pricing overrides", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(
        baseConfig({
          pricing: {
            inputPer1M: 10,
            outputPer1M: 30,
            cachedInputPer1M: 1,
          },
        }),
      );
      await engine.start();

      const p = engine.send("test");
      child.emitStdout(
        JSON.stringify({
          type: "result",
          result: "done",
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }) + "\n",
      );
      child.emit("close", 0, null);
      await p;

      expect(engine.status().usage.costUsd).toBe(10);
    });
  });

  describe("stream-json parsing", () => {
    it("handles assistant message events", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(baseConfig());
      await engine.start();

      const p = engine.send("test");
      // assistant message then result
      child.emitStdout(
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Streaming response" }],
          },
        }) + "\n",
      );
      child.emitStdout(
        JSON.stringify({
          type: "result",
          result: "Final result text",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
          },
        }) + "\n",
      );
      child.emit("close", 0, null);

      const result = await p;
      expect(result).toBe("Final result text");
    });

    it("handles delta/streaming text events", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(baseConfig());
      await engine.start();

      const p = engine.send("test");
      child.emitStdout(
        JSON.stringify({ type: "delta", delta: { text: "Hello " } }) + "\n",
      );
      child.emitStdout(
        JSON.stringify({ type: "delta", delta: { text: "world" } }) + "\n",
      );
      child.emit("close", 0, null);

      const result = await p;
      expect(result).toBe("Hello world");
    });

    it("extracts nested usage from result event", async () => {
      const child = makeChildProcess();
      mockedSpawn.mockReturnValue(child as any);

      const engine = new ClaudeEngine(baseConfig());
      await engine.start();

      const p = engine.send("test");
      child.emitStdout(
        JSON.stringify({
          type: "result",
          result: "ok",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 25,
          },
        }) + "\n",
      );
      child.emit("close", 0, null);
      await p;

      const status = engine.status();
      expect(status.usage.tokenCount.input).toBe(100);
      expect(status.usage.tokenCount.output).toBe(50);
      expect(status.usage.tokenCount.cachedInput).toBe(25);
    });
  });
});
