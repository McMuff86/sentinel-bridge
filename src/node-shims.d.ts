declare const process:
  | {
      platform?: string;
      env?: Record<string, string | undefined>;
    }
  | undefined;

declare module 'node:fs' {
  export const constants: {
    X_OK: number;
  };

  export function accessSync(path: string, mode?: number): void;
}

declare module 'node:path' {
  export const delimiter: string;

  export function isAbsolute(path: string): boolean;
  export function resolve(...paths: string[]): string;
}

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
