import type { EngineKind } from '../types.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit. Default: 5 */
  failureThreshold: number;
  /** Milliseconds to wait before transitioning from open → half-open. Default: 60_000 (1 min) */
  cooldownMs: number;
  /** Number of successes in half-open state to close the circuit. Default: 1 */
  halfOpenSuccessThreshold: number;
}

export interface CircuitSnapshot {
  engine: EngineKind;
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  openedAt: number | null;
  totalFailures: number;
  totalSuccesses: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 60_000,
  halfOpenSuccessThreshold: 1,
};

interface EngineCircuit {
  state: CircuitState;
  consecutiveFailures: number;
  halfOpenSuccesses: number;
  lastFailureAt: number | null;
  openedAt: number | null;
  totalFailures: number;
  totalSuccesses: number;
}

function createCircuit(): EngineCircuit {
  return {
    state: 'closed',
    consecutiveFailures: 0,
    halfOpenSuccesses: 0,
    lastFailureAt: null,
    openedAt: null,
    totalFailures: 0,
    totalSuccesses: 0,
  };
}

export class CircuitBreaker {
  private readonly circuits = new Map<EngineKind, EngineCircuit>();
  private readonly config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if the engine is allowed to receive requests.
   * Transitions open → half-open if cooldown has elapsed.
   */
  isAllowed(engine: EngineKind): boolean {
    const circuit = this.getOrCreate(engine);

    if (circuit.state === 'closed') return true;

    if (circuit.state === 'open') {
      const now = Date.now();
      if (circuit.openedAt && now - circuit.openedAt >= this.config.cooldownMs) {
        circuit.state = 'half-open';
        circuit.halfOpenSuccesses = 0;
        return true;
      }
      return false;
    }

    // half-open: allow requests (probing)
    return true;
  }

  /**
   * Record a successful engine operation. Resets failure count.
   */
  recordSuccess(engine: EngineKind): void {
    const circuit = this.getOrCreate(engine);
    circuit.totalSuccesses += 1;

    if (circuit.state === 'half-open') {
      circuit.halfOpenSuccesses += 1;
      if (circuit.halfOpenSuccesses >= this.config.halfOpenSuccessThreshold) {
        circuit.state = 'closed';
        circuit.consecutiveFailures = 0;
        circuit.openedAt = null;
      }
      return;
    }

    circuit.consecutiveFailures = 0;
  }

  /**
   * Record a failed engine operation. May trip the circuit to open.
   */
  recordFailure(engine: EngineKind): void {
    const circuit = this.getOrCreate(engine);
    circuit.consecutiveFailures += 1;
    circuit.totalFailures += 1;
    circuit.lastFailureAt = Date.now();

    if (circuit.state === 'half-open') {
      // Probe failed — back to open
      circuit.state = 'open';
      circuit.openedAt = Date.now();
      return;
    }

    if (circuit.consecutiveFailures >= this.config.failureThreshold) {
      circuit.state = 'open';
      circuit.openedAt = Date.now();
    }
  }

  /**
   * Manually reset a circuit to closed state.
   */
  reset(engine: EngineKind): void {
    const circuit = this.getOrCreate(engine);
    circuit.state = 'closed';
    circuit.consecutiveFailures = 0;
    circuit.halfOpenSuccesses = 0;
    circuit.openedAt = null;
  }

  /**
   * Get a snapshot of the circuit state for a specific engine.
   */
  getSnapshot(engine: EngineKind): CircuitSnapshot {
    const circuit = this.getOrCreate(engine);

    // Check for auto-transition to half-open on read
    if (circuit.state === 'open' && circuit.openedAt) {
      if (Date.now() - circuit.openedAt >= this.config.cooldownMs) {
        circuit.state = 'half-open';
        circuit.halfOpenSuccesses = 0;
      }
    }

    return {
      engine,
      state: circuit.state,
      consecutiveFailures: circuit.consecutiveFailures,
      lastFailureAt: circuit.lastFailureAt,
      openedAt: circuit.openedAt,
      totalFailures: circuit.totalFailures,
      totalSuccesses: circuit.totalSuccesses,
    };
  }

  /**
   * Get snapshots for all tracked engines.
   */
  getAllSnapshots(): CircuitSnapshot[] {
    const engines: EngineKind[] = ['claude', 'codex', 'grok', 'ollama'];
    return engines.map(e => this.getSnapshot(e));
  }

  private getOrCreate(engine: EngineKind): EngineCircuit {
    let circuit = this.circuits.get(engine);
    if (!circuit) {
      circuit = createCircuit();
      this.circuits.set(engine, circuit);
    }
    return circuit;
  }
}
