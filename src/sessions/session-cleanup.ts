import type { SessionRecord } from './types.js';

export function cleanupExpiredSessions(
  sessions: Map<string, SessionRecord>,
  ttlMs: number,
  now = Date.now(),
): void {
  for (const [name, record] of sessions.entries()) {
    if (now - record.lastTouchedAt < ttlMs) {
      continue;
    }

    record.session.status = 'expired';
    sessions.delete(name);
    void record.engineInstance.stop().catch(() => {
      // Expired sessions are best-effort cleaned up in the background.
    });
  }
}
