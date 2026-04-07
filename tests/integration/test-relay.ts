#!/usr/bin/env npx tsx
/**
 * Integration test: session-to-session relay.
 *
 * Starts two Claude sessions, sends a message to session A,
 * relays A's response to session B, and verifies B responded.
 *
 * Requires: Claude CLI installed and authenticated.
 * Run:      npx tsx tests/integration/test-relay.ts
 */

import { SessionManager } from '../../src/session-manager.js';
import { isClaudeCliAvailable, printResult, printSkip } from './helpers.js';

const TEST_NAME = 'test-relay';

async function run(): Promise<boolean> {
  if (!isClaudeCliAvailable()) {
    printSkip(TEST_NAME, 'Claude CLI not found on PATH. Install and authenticate it to run this test.');
    return true;
  }

  const manager = new SessionManager({
    cleanupIntervalMs: 0,
    defaultFallbackChain: [],
  });

  const sessionA = 'integ-relay-a';
  const sessionB = 'integ-relay-b';

  try {
    // --- Step 1: Start two sessions ---
    console.log('Starting session A...');
    const infoA = await manager.startSession({
      name: sessionA,
      engine: 'claude',
      model: 'sonnet',
    });
    console.log(`  Session A started: engine=${infoA.engine}, model=${infoA.model}`);

    console.log('Starting session B...');
    const infoB = await manager.startSession({
      name: sessionB,
      engine: 'claude',
      model: 'sonnet',
    });
    console.log(`  Session B started: engine=${infoB.engine}, model=${infoB.model}`);

    // --- Step 2: Send message to session A ---
    console.log('Sending message to session A...');
    const resultA = await manager.sendMessage(
      sessionA,
      'Reply with exactly this phrase and nothing else: RELAY_PAYLOAD_42',
    );
    console.log(`  Session A responded: "${resultA.output.trim()}"`);

    const payloadOk = resultA.output.includes('RELAY_PAYLOAD_42');
    if (!payloadOk) {
      console.log('  Warning: Session A did not produce exact payload. Proceeding with relay anyway.');
    }

    // --- Step 3: Relay A's response to session B ---
    const relayMessage = `You received the following message from another session: "${resultA.output.trim()}". Acknowledge by replying with: RELAY_RECEIVED`;
    console.log('Relaying message from A to B...');
    const relayResult = await manager.relayMessage(sessionA, sessionB, relayMessage);

    console.log(`  Relay result: from=${relayResult.from}, to=${relayResult.to}`);
    console.log(`  Session B responded: "${relayResult.sendResult.output.trim()}"`);

    // --- Step 4: Verify B responded ---
    const bResponded = relayResult.sendResult.output.length > 0;
    if (!bResponded) {
      printResult(TEST_NAME, false, 'Session B returned empty response after relay.');
      await cleanup(manager, sessionA, sessionB);
      return false;
    }

    // Check B's session has turn count incremented
    const statusB = manager.getSessionStatus(sessionB);
    if (!statusB || statusB.turnCount < 1) {
      printResult(TEST_NAME, false, `Session B turn count should be >= 1, got ${statusB?.turnCount ?? 0}`);
      await cleanup(manager, sessionA, sessionB);
      return false;
    }
    console.log(`  Session B turns: ${statusB.turnCount}`);

    // --- Cleanup ---
    await cleanup(manager, sessionA, sessionB);

    printResult(TEST_NAME, true, 'Relay from session A to session B succeeded. Both sessions responded.');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    printResult(TEST_NAME, false, `Unexpected error: ${msg}`);
    await cleanup(manager, sessionA, sessionB);
    return false;
  }
}

async function cleanup(manager: SessionManager, ...sessionNames: string[]): Promise<void> {
  try {
    for (const name of sessionNames) {
      await manager.stopSession(name).catch(() => {});
    }
    await manager.dispose();
  } catch { /* best effort */ }
}

export { TEST_NAME };
export default run;

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('test-relay.ts');
if (isDirectRun) {
  run().then(ok => process.exit(ok ? 0 : 1));
}
