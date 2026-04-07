import { describe, it, expect } from 'vitest';

import { SessionQueue } from '../orchestration/session-queue.js';

describe('SessionQueue', () => {
  describe('basic operations', () => {
    it('should have zero depth initially', () => {
      const q = new SessionQueue();
      expect(q.depth).toBe(0);
      expect(q.hasWaiters).toBe(false);
    });

    it('should enqueue and release', async () => {
      const q = new SessionQueue({ maxDepth: 5, timeoutMs: 5000 });

      const promise = q.enqueue('session-1');
      expect(q.depth).toBe(1);
      expect(q.hasWaiters).toBe(true);

      q.release();
      await promise;
      expect(q.depth).toBe(0);
    });

    it('should release in FIFO order within same priority', async () => {
      const q = new SessionQueue({ maxDepth: 5, timeoutMs: 5000 });
      const order: string[] = [];

      const p1 = q.enqueue('a').then(() => order.push('a'));
      const p2 = q.enqueue('b').then(() => order.push('b'));
      const p3 = q.enqueue('c').then(() => order.push('c'));

      q.release();
      await new Promise(r => setTimeout(r, 10));
      q.release();
      await new Promise(r => setTimeout(r, 10));
      q.release();

      await Promise.all([p1, p2, p3]);
      expect(order).toEqual(['a', 'b', 'c']);
    });
  });

  describe('priority', () => {
    it('should release high priority before lower priorities', async () => {
      const q = new SessionQueue({ maxDepth: 5, timeoutMs: 5000 });
      const order: string[] = [];

      // Enqueue in order: normal, low, high
      const pNormal = q.enqueue('normal-1', 'normal').then(() => order.push('normal-1'));
      const pLow = q.enqueue('low-1', 'low').then(() => order.push('low-1'));
      const pHigh = q.enqueue('high-1', 'high').then(() => order.push('high-1'));

      // High should be at front of queue due to priority insertion
      q.release();
      await new Promise(r => setTimeout(r, 10));
      q.release();
      await new Promise(r => setTimeout(r, 10));
      q.release();

      await Promise.all([pNormal, pLow, pHigh]);
      expect(order[0]).toBe('high-1');
      expect(order[2]).toBe('low-1');
    });

    it('should report priority breakdown in snapshot', async () => {
      const q = new SessionQueue({ maxDepth: 10, timeoutMs: 5000 });

      const promises = [
        q.enqueue('a', 'high'),
        q.enqueue('b', 'normal'),
        q.enqueue('c', 'low'),
        q.enqueue('d', 'normal'),
      ];

      const snap = q.getSnapshot();
      expect(snap.depth).toBe(4);
      expect(snap.highPriority).toBe(1);
      expect(snap.normalPriority).toBe(2);
      expect(snap.lowPriority).toBe(1);

      // Clean up properly — release all to avoid unhandled rejections
      q.release(); q.release(); q.release(); q.release();
      await Promise.allSettled(promises);
    });
  });

  describe('max depth', () => {
    it('should reject when queue is full', async () => {
      const q = new SessionQueue({ maxDepth: 2, timeoutMs: 5000 });

      const p1 = q.enqueue('a');
      const p2 = q.enqueue('b');

      let error: Error | null = null;
      try {
        await q.enqueue('c');
      } catch (e) {
        error = e as Error;
      }
      expect(error).not.toBeNull();
      expect(error!.message).toContain('queue is full');

      q.release(); q.release();
      await Promise.allSettled([p1, p2]);
    });
  });

  describe('timeout', () => {
    it('should reject entries that exceed timeout', async () => {
      const q = new SessionQueue({ maxDepth: 5, timeoutMs: 50 });

      let error: Error | null = null;
      try {
        await q.enqueue('slow');
      } catch (e) {
        error = e as Error;
      }
      expect(error).not.toBeNull();
      expect(error!.message).toContain('timed out waiting');
    });
  });

  describe('rejectAll', () => {
    it('should reject all waiting entries', async () => {
      const q = new SessionQueue({ maxDepth: 5, timeoutMs: 5000 });

      const results: string[] = [];
      const p1 = q.enqueue('a').then(() => results.push('resolved')).catch(() => results.push('rejected-a'));
      const p2 = q.enqueue('b').then(() => results.push('resolved')).catch(() => results.push('rejected-b'));

      q.rejectAll('shutting down');

      await Promise.allSettled([p1, p2]);
      expect(results).toEqual(['rejected-a', 'rejected-b']);
      expect(q.depth).toBe(0);
    });
  });

  describe('release without waiters', () => {
    it('should return false when no waiters', () => {
      const q = new SessionQueue();
      expect(q.release()).toBe(false);
    });
  });

  describe('snapshot', () => {
    it('should return correct snapshot', () => {
      const q = new SessionQueue({ maxDepth: 10, timeoutMs: 5000 });
      const snap = q.getSnapshot();
      expect(snap.depth).toBe(0);
      expect(snap.maxDepth).toBe(10);
    });
  });
});
