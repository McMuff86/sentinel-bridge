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
  export function appendFileSync(path: string, data: string, options?: { encoding?: string } | BufferEncoding): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function readFileSync(path: string, options: { encoding: string } | BufferEncoding): string;
  export function readFileSync(path: string): Buffer;
  export function renameSync(oldPath: string, newPath: string): void;
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void;
  export function writeFileSync(path: string, data: string, options?: { encoding?: string } | BufferEncoding): void;
}

declare module 'node:path' {
  export const delimiter: string;

  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args?: string[],
    options?: {
      timeout?: number;
      stdio?: unknown;
      env?: Record<string, string | undefined>;
    },
  ): string | Buffer;

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
