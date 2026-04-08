/**
 * Structured logging for sentinel-bridge.
 *
 * Wraps an optional external logger (OpenClaw PluginApi.logger) and provides
 * structured log entries with level, category, session context, and metadata.
 *
 * Logs are emitted as single-line JSON to the external logger when available,
 * making them parseable by log aggregators. When no external logger is
 * configured, logs go to stderr as a fallback.
 */

import type { EngineKind } from './types.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogCategory =
  | 'session'
  | 'engine'
  | 'routing'
  | 'fallback'
  | 'rehydration'
  | 'expiry'
  | 'store'
  | 'config'
  | 'cleanup'
  | 'context'
  | 'orchestration';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  session?: string;
  engine?: EngineKind;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

export interface ExternalLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export class StructuredLogger {
  private readonly external: ExternalLogger | undefined;
  private readonly minLevel: LogLevel;

  private static readonly LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(external?: ExternalLogger, minLevel: LogLevel = 'info') {
    this.external = external;
    this.minLevel = minLevel;
  }

  debug(category: LogCategory, message: string, context?: Partial<Omit<LogEntry, 'ts' | 'level' | 'category' | 'message'>>): void {
    this.log('debug', category, message, context);
  }

  info(category: LogCategory, message: string, context?: Partial<Omit<LogEntry, 'ts' | 'level' | 'category' | 'message'>>): void {
    this.log('info', category, message, context);
  }

  warn(category: LogCategory, message: string, context?: Partial<Omit<LogEntry, 'ts' | 'level' | 'category' | 'message'>>): void {
    this.log('warn', category, message, context);
  }

  error(category: LogCategory, message: string, context?: Partial<Omit<LogEntry, 'ts' | 'level' | 'category' | 'message'>>): void {
    this.log('error', category, message, context);
  }

  private log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    context?: Partial<Omit<LogEntry, 'ts' | 'level' | 'category' | 'message'>>,
  ): void {
    if (StructuredLogger.LEVEL_ORDER[level] < StructuredLogger.LEVEL_ORDER[this.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      category,
      message,
      ...context,
    };

    const line = `[sentinel-bridge] ${JSON.stringify(entry)}`;

    if (this.external) {
      switch (level) {
        case 'debug':
        case 'info':
          this.external.info(line);
          break;
        case 'warn':
          this.external.warn(line);
          break;
        case 'error':
          this.external.error(line);
          break;
      }
    } else {
      if (level === 'error' || level === 'warn') {
        console.error(line);
      } else {
        console.log(line);
      }
    }
  }
}
