import type { ChildProcess } from 'node:child_process';

import { EngineError } from '../errors.js';
import type { ErrorCategory } from '../errors.js';

export type JsonRecord = Record<string, unknown>;

export function parseJsonLine(line: string): JsonRecord | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isJsonRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function getNestedValue(record: JsonRecord, path: string[]): unknown {
  let current: unknown = record;

  for (const segment of path) {
    if (!isJsonRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

export function getJsonRecord(value: unknown): JsonRecord | undefined {
  return isJsonRecord(value) ? value : undefined;
}

export function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') {
    return chunk;
  }

  if (chunk instanceof Uint8Array) {
    return new TextDecoder().decode(chunk);
  }

  return String(chunk);
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createSpawnError(engineLabel: string, error: unknown): EngineError {
  if (isJsonRecord(error) && error.code === 'ENOENT') {
    return new EngineError(
      `${engineLabel} CLI not found. Install \`${engineLabel.toLowerCase()}\` and ensure it is available on PATH.`,
      'unavailable',
    );
  }

  const message = error instanceof Error ? error.message : `${engineLabel} process failed to start.`;
  return new EngineError(message || `${engineLabel} process failed to start.`, 'unknown', { cause: error });
}

export interface ProcessErrorOptions {
  engineLabel: string;
  authRegex: RegExp;
  authMessage: string;
  authCategory: ErrorCategory;
}

export function createProcessError(
  stderr: string,
  code: number | null,
  signal: string | null,
  options: ProcessErrorOptions,
): EngineError {
  const trimmed = stderr.trim();

  if (options.authRegex.test(trimmed)) {
    return new EngineError(options.authMessage, options.authCategory);
  }

  const detail = trimmed || `exit code ${code ?? 'unknown'} signal ${signal ?? 'none'}`;
  return new EngineError(`${options.engineLabel} command failed: ${detail}`, 'unknown');
}

export function killProcessGracefully(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    proc.kill('SIGTERM');

    const forceKillTimer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 1_000);

    proc.once('close', () => {
      clearTimeout(forceKillTimer);
      resolve();
    });
  });
}
