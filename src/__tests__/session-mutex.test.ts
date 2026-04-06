import { describe, it, expect } from 'vitest';
import { SessionMutex } from '../sessions/session-mutex.js';

describe('SessionMutex', () => {
  it('allows sequential acquire/release on the same key', async () => {
    const mutex = new SessionMutex();

    const release1 = await mutex.acquire('a');
    expect(mutex.isLocked('a')).toBe(true);
    release1();
    expect(mutex.isLocked('a')).toBe(false);

    const release2 = await mutex.acquire('a');
    expect(mutex.isLocked('a')).toBe(true);
    release2();
  });

  it('allows concurrent acquire on different keys', async () => {
    const mutex = new SessionMutex();

    const releaseA = await mutex.acquire('a');
    const releaseB = await mutex.acquire('b');

    expect(mutex.isLocked('a')).toBe(true);
    expect(mutex.isLocked('b')).toBe(true);
    expect(mutex.size).toBe(2);

    releaseA();
    releaseB();
  });

  it('serialises concurrent acquire on the same key', async () => {
    const mutex = new SessionMutex();
    const order: string[] = [];

    const release1 = await mutex.acquire('a');

    // Second acquire should wait
    const p2 = mutex.acquire('a').then((release) => {
      order.push('second-acquired');
      return release;
    });

    // Give p2 a tick to try — it should NOT resolve yet
    await new Promise((r) => setTimeout(r, 10));
    expect(order).not.toContain('second-acquired');

    order.push('first-released');
    release1();

    // Now p2 should resolve
    const release2 = await p2;
    expect(order).toEqual(['first-released', 'second-acquired']);
    release2();
  });

  it('processes three queued operations in order', async () => {
    const mutex = new SessionMutex();
    const order: number[] = [];

    async function worker(id: number, delayMs: number): Promise<void> {
      const release = await mutex.acquire('shared');
      order.push(id);
      await new Promise((r) => setTimeout(r, delayMs));
      release();
    }

    // Start all three concurrently
    const p1 = worker(1, 20);
    const p2 = worker(2, 10);
    const p3 = worker(3, 5);

    await Promise.all([p1, p2, p3]);

    // Should execute in FIFO order despite different durations
    expect(order).toEqual([1, 2, 3]);
  });

  it('releases lock even if holder throws', async () => {
    const mutex = new SessionMutex();

    const release = await mutex.acquire('a');
    // Simulate error — caller should still release in finally
    try {
      throw new Error('boom');
    } catch {
      // expected
    } finally {
      release();
    }

    // Should be acquirable again
    expect(mutex.isLocked('a')).toBe(false);
    const release2 = await mutex.acquire('a');
    release2();
  });
});
