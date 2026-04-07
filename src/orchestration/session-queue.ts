export type QueuePriority = 'high' | 'normal' | 'low';

export interface QueueConfig {
  /** Max items waiting in queue. Default: 20. 0 = unlimited. */
  maxDepth: number;
  /** Max time an item can wait in queue (ms). Default: 120_000 (2 min). */
  timeoutMs: number;
}

export interface QueueEntry<T> {
  item: T;
  priority: QueuePriority;
  enqueuedAt: number;
  resolve: () => void;
  reject: (reason: Error) => void;
}

export interface QueueSnapshot {
  depth: number;
  maxDepth: number;
  highPriority: number;
  normalPriority: number;
  lowPriority: number;
}

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

const DEFAULT_CONFIG: QueueConfig = {
  maxDepth: 20,
  timeoutMs: 120_000,
};

/**
 * A simple priority queue that blocks callers until a slot is available.
 * Used to implement backpressure on session starts when at max capacity.
 *
 * Instead of rejecting immediately when maxConcurrentSessions is reached,
 * callers wait in the queue and are released in priority order when a slot
 * becomes available.
 */
export class SessionQueue {
  private readonly queue: Array<QueueEntry<string>> = [];
  private readonly config: QueueConfig;

  constructor(config?: Partial<QueueConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Wait in the queue until a slot is available.
   * Resolves immediately if the queue is empty and a slot checker returns true.
   * Otherwise waits until `release()` is called.
   */
  async enqueue(sessionName: string, priority: QueuePriority = 'normal'): Promise<void> {
    if (this.config.maxDepth > 0 && this.queue.length >= this.config.maxDepth) {
      throw new Error(
        `Session queue is full (${this.queue.length}/${this.config.maxDepth}). ` +
        'Try again later or increase queue depth.',
      );
    }

    return new Promise<void>((resolve, reject) => {
      let timerId: ReturnType<typeof setTimeout> | null = null;

      const entry: QueueEntry<string> = {
        item: sessionName,
        priority,
        enqueuedAt: Date.now(),
        resolve: () => {
          if (timerId !== null) clearTimeout(timerId);
          resolve();
        },
        reject: (reason: Error) => {
          if (timerId !== null) clearTimeout(timerId);
          reject(reason);
        },
      };

      // Insert in priority order (high first, then by arrival time within same priority)
      const insertIndex = this.queue.findIndex(
        e => PRIORITY_ORDER[e.priority] > PRIORITY_ORDER[priority],
      );
      if (insertIndex === -1) {
        this.queue.push(entry);
      } else {
        this.queue.splice(insertIndex, 0, entry);
      }

      // Set timeout
      if (this.config.timeoutMs > 0) {
        timerId = setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            reject(new Error(
              `Session "${sessionName}" timed out waiting in queue after ${this.config.timeoutMs}ms.`,
            ));
          }
        }, this.config.timeoutMs);
      }
    });
  }

  /**
   * Release the next waiting entry from the queue (highest priority first).
   * Call this when a session slot becomes available (e.g. after stopSession).
   */
  release(): boolean {
    if (this.queue.length === 0) return false;

    // Remove expired entries first
    const now = Date.now();
    while (this.queue.length > 0) {
      const front = this.queue[0];
      if (this.config.timeoutMs > 0 && now - front.enqueuedAt > this.config.timeoutMs) {
        this.queue.shift();
        // Already rejected by the timeout callback
        continue;
      }
      break;
    }

    if (this.queue.length === 0) return false;

    const entry = this.queue.shift()!;
    entry.resolve();
    return true;
  }

  /**
   * Reject all waiting entries (e.g. on shutdown).
   */
  rejectAll(reason: string): void {
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      entry.reject(new Error(reason));
    }
  }

  /** Current queue depth. */
  get depth(): number {
    return this.queue.length;
  }

  /** True if there are waiting entries. */
  get hasWaiters(): boolean {
    return this.queue.length > 0;
  }

  /** Snapshot of queue state. */
  getSnapshot(): QueueSnapshot {
    return {
      depth: this.queue.length,
      maxDepth: this.config.maxDepth,
      highPriority: this.queue.filter(e => e.priority === 'high').length,
      normalPriority: this.queue.filter(e => e.priority === 'normal').length,
      lowPriority: this.queue.filter(e => e.priority === 'low').length,
    };
  }
}
