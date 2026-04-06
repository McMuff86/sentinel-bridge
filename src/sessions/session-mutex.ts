/**
 * Per-key promise-based mutex.
 *
 * Serialises async operations on the same key (session name) so that
 * concurrent send/stop/compact/rehydrate calls don't race.
 *
 * Usage:
 *   const release = await mutex.acquire('my-session');
 *   try { … } finally { release(); }
 */
export class SessionMutex {
  private readonly locks = new Map<string, Promise<void>>();

  /**
   * Acquire exclusive access for the given key.
   * Returns a release function that MUST be called when done.
   */
  async acquire(key: string): Promise<() => void> {
    // Wait for any existing lock on this key to finish
    while (this.locks.has(key)) {
      try {
        await this.locks.get(key);
      } catch {
        // Previous holder threw — we still proceed
      }
    }

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, gate);

    return () => {
      // Only delete if this is still our gate (not replaced by a later acquire)
      if (this.locks.get(key) === gate) {
        this.locks.delete(key);
      }
      release();
    };
  }

  /** Check whether a key currently has a lock held. */
  isLocked(key: string): boolean {
    return this.locks.has(key);
  }

  /** Number of keys currently locked. */
  get size(): number {
    return this.locks.size;
  }
}
