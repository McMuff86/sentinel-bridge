#!/usr/bin/env npx tsx
/**
 * Integration test: shared context (blackboard).
 *
 * Does NOT need any real engine. Tests the ContextStore through SessionManager
 * to verify cross-session visibility of shared state.
 *
 * Run: npx tsx tests/integration/test-context-blackboard.ts
 */

import { SessionManager } from '../../src/session-manager.js';
import { printResult } from './helpers.js';

const TEST_NAME = 'test-context-blackboard';

function assertEqual<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function run(): Promise<boolean> {
  const workspace = `integ-test-ctx-${Date.now()}`;

  const manager = new SessionManager({
    cleanupIntervalMs: 0,
  });

  try {
    // --- Step 1: Set values from different "session" names ---
    console.log('Step 1: Set context values from two different sessions...');
    const entry1 = await manager.setContext(workspace, 'shared.counter', 42, 'session-alpha');
    const entry2 = await manager.setContext(workspace, 'shared.label', 'hello-world', 'session-beta');

    assertEqual('entry1 key', entry1.key, 'shared.counter');
    assertEqual('entry1 value', entry1.value as number, 42);
    assertEqual('entry1 setBy', entry1.setBy, 'session-alpha');

    assertEqual('entry2 key', entry2.key, 'shared.label');
    assertEqual('entry2 value', entry2.value as string, 'hello-world');
    assertEqual('entry2 setBy', entry2.setBy, 'session-beta');

    console.log(`  Set "shared.counter" = 42 (by session-alpha)`);
    console.log(`  Set "shared.label" = "hello-world" (by session-beta)`);

    // --- Step 2: Read back values (cross-session visibility) ---
    console.log('Step 2: Read values back — verifying cross-session visibility...');
    const read1 = manager.getContext(workspace, 'shared.counter');
    const read2 = manager.getContext(workspace, 'shared.label');

    if (!read1) {
      throw new Error('getContext returned undefined for "shared.counter"');
    }
    if (!read2) {
      throw new Error('getContext returned undefined for "shared.label"');
    }

    assertEqual('read1 value', read1.value as number, 42);
    assertEqual('read1 setBy', read1.setBy, 'session-alpha');
    assertEqual('read2 value', read2.value as string, 'hello-world');
    assertEqual('read2 setBy', read2.setBy, 'session-beta');
    console.log(`  Read "shared.counter" = ${read1.value} (set by ${read1.setBy})`);
    console.log(`  Read "shared.label" = "${read2.value}" (set by ${read2.setBy})`);

    // --- Step 3: List all entries ---
    console.log('Step 3: List all context entries...');
    const allEntries = manager.listContext(workspace);
    assertEqual('entry count', allEntries.length, 2);
    console.log(`  Found ${allEntries.length} entries.`);

    // --- Step 4: Overwrite a value from a different session ---
    console.log('Step 4: Overwrite "shared.counter" from session-beta...');
    const updated = await manager.setContext(workspace, 'shared.counter', 99, 'session-beta');
    assertEqual('updated value', updated.value as number, 99);
    assertEqual('updated setBy', updated.setBy, 'session-beta');

    const readUpdated = manager.getContext(workspace, 'shared.counter');
    assertEqual('readUpdated value', readUpdated?.value as number, 99);
    console.log(`  "shared.counter" is now ${readUpdated?.value} (set by ${readUpdated?.setBy})`);

    // --- Step 5: Read non-existent key ---
    console.log('Step 5: Read non-existent key...');
    const missing = manager.getContext(workspace, 'does.not.exist');
    assertEqual('missing key', missing, undefined);
    console.log('  Non-existent key correctly returns undefined.');

    // --- Step 6: Clear workspace and verify empty ---
    console.log('Step 6: Clear workspace and verify empty...');
    await manager.clearContext(workspace, 'test-cleanup');
    const afterClear = manager.listContext(workspace);
    assertEqual('entries after clear', afterClear.length, 0);

    const readAfterClear = manager.getContext(workspace, 'shared.counter');
    assertEqual('read after clear', readAfterClear, undefined);
    console.log('  Workspace cleared. All entries removed.');

    // --- Step 7: Verify context events were recorded ---
    console.log('Step 7: Verify context events were recorded...');
    const events = manager.contextEvents.listEvents(workspace, 100);
    // We did: set, set, set (overwrite), clear = at least 4 events
    const hasEvents = events.length >= 4;
    if (!hasEvents) {
      throw new Error(`Expected >= 4 context events, got ${events.length}`);
    }
    console.log(`  Found ${events.length} context events for workspace.`);

    await manager.dispose();

    printResult(TEST_NAME, true, 'Context blackboard: set, read, cross-session visibility, overwrite, clear, and events all verified.');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    printResult(TEST_NAME, false, msg);
    try {
      await manager.clearContext(workspace, 'test-cleanup').catch(() => {});
      await manager.dispose();
    } catch { /* best effort */ }
    return false;
  }
}

export { TEST_NAME };
export default run;

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('test-context-blackboard.ts');
if (isDirectRun) {
  run().then(ok => process.exit(ok ? 0 : 1));
}
