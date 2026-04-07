import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, resolve as resolvePath } from 'node:path';

import type { EngineKind } from '../types.js';
import type { CircuitBreaker } from './circuit-breaker.js';

export interface HealthCheckResult {
  engine: EngineKind;
  healthy: boolean;
  latencyMs: number;
  checkedAt: string;
  error?: string;
}

export interface HealthCheckConfig {
  /** Interval between health checks in milliseconds. Default: 120_000 (2 min). 0 disables. */
  intervalMs: number;
  /** Timeout for each probe in milliseconds. Default: 5_000. */
  probeTimeoutMs: number;
  /** Grok API base URL for health probe. */
  grokBaseUrl?: string;
  /** Grok API key for authenticated probe. */
  grokApiKey?: string;
  /** Ollama base URL. Default: http://localhost:11434/v1 */
  ollamaBaseUrl?: string;
}

const DEFAULT_CONFIG: HealthCheckConfig = {
  intervalMs: 120_000,
  probeTimeoutMs: 5_000,
  ollamaBaseUrl: 'http://localhost:11434/v1',
};

export class HealthChecker {
  private readonly config: HealthCheckConfig;
  private readonly results = new Map<EngineKind, HealthCheckResult>();
  private readonly circuitBreaker: CircuitBreaker | undefined;
  private timer: { unref?: () => void } | null = null;

  constructor(config?: Partial<HealthCheckConfig>, circuitBreaker?: CircuitBreaker) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.circuitBreaker = circuitBreaker;
  }

  /** Start periodic health checks. */
  start(): void {
    if (this.config.intervalMs <= 0) return;
    if (this.timer) return;

    // Run immediately, then periodically
    void this.checkAll();
    this.timer = setInterval(() => {
      void this.checkAll();
    }, this.config.intervalMs) as unknown as { unref?: () => void };
    this.timer.unref?.();
  }

  /** Stop periodic health checks. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer as unknown as number);
      this.timer = null;
    }
  }

  /** Run health checks on all engines. */
  async checkAll(): Promise<HealthCheckResult[]> {
    const engines: EngineKind[] = ['claude', 'codex', 'grok', 'ollama'];
    const results = await Promise.all(engines.map(e => this.check(e)));
    return results;
  }

  /** Run a health check on a specific engine. */
  async check(engine: EngineKind): Promise<HealthCheckResult> {
    const start = Date.now();
    let healthy = false;
    let error: string | undefined;

    try {
      switch (engine) {
        case 'claude':
          healthy = checkCliAvailable('claude');
          if (!healthy) error = 'claude CLI not found on PATH';
          break;
        case 'codex':
          healthy = checkCliAvailable('codex');
          if (!healthy) error = 'codex CLI not found on PATH';
          break;
        case 'grok':
          healthy = await this.probeGrok();
          if (!healthy) error = 'Grok API unreachable or unauthorized';
          break;
        case 'ollama':
          healthy = await this.probeOllama();
          if (!healthy) error = 'Ollama not reachable';
          break;
      }
    } catch (e) {
      healthy = false;
      error = e instanceof Error ? e.message : String(e);
    }

    const result: HealthCheckResult = {
      engine,
      healthy,
      latencyMs: Date.now() - start,
      checkedAt: new Date().toISOString(),
      error,
    };

    this.results.set(engine, result);

    // Feed into circuit breaker if available
    if (this.circuitBreaker) {
      if (healthy) {
        this.circuitBreaker.recordSuccess(engine);
      }
      // Don't record failure for health checks — only real request failures
      // should trip the circuit. Health checks inform, they don't penalize.
    }

    return result;
  }

  /** Get the latest health check result for an engine. */
  getResult(engine: EngineKind): HealthCheckResult | undefined {
    return this.results.get(engine);
  }

  /** Get all latest health check results. */
  getAllResults(): HealthCheckResult[] {
    const engines: EngineKind[] = ['claude', 'codex', 'grok', 'ollama'];
    return engines.map(e => this.results.get(e) ?? {
      engine: e,
      healthy: false,
      latencyMs: 0,
      checkedAt: '',
      error: 'Not checked yet',
    });
  }

  private async probeGrok(): Promise<boolean> {
    if (!this.config.grokBaseUrl && !this.config.grokApiKey) {
      // No config — can't check, assume unavailable
      return false;
    }

    const baseUrl = this.config.grokBaseUrl ?? 'https://api.x.ai/v1';
    const url = `${baseUrl}/models`;

    try {
      const headers: Record<string, string> = {};
      if (this.config.grokApiKey) {
        headers['Authorization'] = `Bearer ${this.config.grokApiKey}`;
      }

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.config.probeTimeoutMs),
      });

      return response.ok || response.status === 401; // 401 = API is reachable but key wrong
    } catch {
      return false;
    }
  }

  private async probeOllama(): Promise<boolean> {
    const baseUrl = this.config.ollamaBaseUrl ?? 'http://localhost:11434/v1';
    // Strip /v1 suffix for root health check
    const rootUrl = baseUrl.replace(/\/v1\/?$/, '');

    try {
      const response = await fetch(rootUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(this.config.probeTimeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

/** Check if a CLI binary is available on PATH. */
function checkCliAvailable(command: string): boolean {
  const pathValue = process?.env?.PATH ?? '';
  const extensions =
    process?.platform === 'win32'
      ? (process?.env?.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
      : [''];

  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidatePath = resolvePath(directory, `${command}${extension}`);
      try {
        accessSync(candidatePath, constants.X_OK);
        return true;
      } catch {
        // Not found in this directory
      }
    }
  }

  return false;
}
