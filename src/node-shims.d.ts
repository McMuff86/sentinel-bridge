declare const process:
  | {
      env?: Record<string, string | undefined>;
    }
  | undefined;

declare module "node:child_process" {
  export function spawn(
    command: string,
    args?: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdio?: unknown;
    },
  ): {
    stdout: {
      on(event: "data", listener: (chunk: unknown) => void): void;
    };
    stderr: {
      on(event: "data", listener: (chunk: unknown) => void): void;
    };
    once(event: "error", listener: (error: unknown) => void): void;
    once(
      event: "close",
      listener: (code: number | null, signal: string | null) => void,
    ): void;
    kill(signal?: string): void;
  };
}
