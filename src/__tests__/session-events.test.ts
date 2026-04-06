import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionEventStore } from '../sessions/session-events.js';
import type { SessionEvent } from '../sessions/session-events.js';

describe('SessionEventStore', () => {
  let dir: string;
  let store: SessionEventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sb-events-'));
    store = new SessionEventStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeEvent(
    overrides: Partial<SessionEvent> = {},
  ): SessionEvent {
    return {
      ts: new Date().toISOString(),
      type: 'session_started',
      engine: 'claude',
      sessionName: 'test-session',
      ...overrides,
    };
  }

  it('returns empty array for unknown session', () => {
    expect(store.listEvents('nonexistent')).toEqual([]);
  });

  it('appends and retrieves events', () => {
    const e1 = makeEvent({ type: 'session_started' });
    const e2 = makeEvent({ type: 'message_sent', preview: 'hello' });
    const e3 = makeEvent({ type: 'message_completed' });

    store.appendEvent(e1);
    store.appendEvent(e2);
    store.appendEvent(e3);

    const events = store.listEvents('test-session');
    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe('session_started');
    expect(events[1]!.type).toBe('message_sent');
    expect(events[1]!.preview).toBe('hello');
    expect(events[2]!.type).toBe('message_completed');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      store.appendEvent(makeEvent({ type: 'message_sent' }));
    }

    const events = store.listEvents('test-session', 3);
    expect(events).toHaveLength(3);
  });

  it('returns all events when limit is 0', () => {
    for (let i = 0; i < 5; i++) {
      store.appendEvent(makeEvent());
    }

    expect(store.listEvents('test-session', 0)).toHaveLength(5);
  });

  it('isolates events by session name', () => {
    store.appendEvent(makeEvent({ sessionName: 'alpha' }));
    store.appendEvent(makeEvent({ sessionName: 'alpha' }));
    store.appendEvent(makeEvent({ sessionName: 'beta' }));

    expect(store.listEvents('alpha')).toHaveLength(2);
    expect(store.listEvents('beta')).toHaveLength(1);
  });

  it('clearEvents removes the session log', () => {
    store.appendEvent(makeEvent());
    expect(store.listEvents('test-session')).toHaveLength(1);

    store.clearEvents('test-session');
    expect(store.listEvents('test-session')).toEqual([]);
  });

  it('stores error field on failed events', () => {
    store.appendEvent(
      makeEvent({ type: 'message_failed', error: 'timeout' }),
    );

    const events = store.listEvents('test-session');
    expect(events[0]!.error).toBe('timeout');
  });

  it('sanitises session names with special characters', () => {
    const name = 'my/session:with.special chars!';
    store.appendEvent(makeEvent({ sessionName: name }));

    const events = store.listEvents(name);
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionName).toBe(name);
  });

  it('skips malformed JSONL lines without crashing', () => {
    // Write a valid event, then a corrupt line, then another valid event
    store.appendEvent(makeEvent({ type: 'session_started' }));

    const filePath = join(dir, 'test-session.jsonl');
    appendFileSync(filePath, 'NOT VALID JSON\n', 'utf8');

    store.appendEvent(makeEvent({ type: 'session_stopped' }));

    const events = store.listEvents('test-session');
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('session_started');
    expect(events[1]!.type).toBe('session_stopped');
  });

  it('prunes events beyond maxEvents limit', () => {
    const smallStore = new SessionEventStore(dir, 5);

    for (let i = 0; i < 10; i++) {
      smallStore.appendEvent(
        makeEvent({ type: 'message_sent', preview: `msg-${i}` }),
      );
    }

    const events = smallStore.listEvents('test-session', 100);
    expect(events.length).toBeLessThanOrEqual(5);
    // Should keep the latest events
    expect(events[events.length - 1]!.preview).toBe('msg-9');
  });
});
