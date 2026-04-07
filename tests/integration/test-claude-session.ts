#!/usr/bin/env npx tsx
/**
 * Integration test: Claude session — start, send, verify, stop.
 *
 * Requires: Claude CLI installed and authenticated.
 * Run:      npx tsx tests/integration/test-claude-session.ts
 */

import { SessionManager } from '../../src/session-manager.js';
import { isClaudeCliAvailable, printResult, printSkip } from './helpers.js';

const TEST_NAME = 'test-claude-session';

async function run(): Promise<boolean> {
  if (!isClaudeCliAvailable()) {
    printSkip(TEST_NAME, 'Claude CLI not found on PATH. Install and authenticate it to run this test.');
    return true; // skip counts as non-failure
  }

  const manager = new SessionManager({
    cleanupIntervalMs: 0, // disable background cleanup timer
    defaultFallbackChain: [], // no fallback — fail fast
  });

  const sessionName = 'integ-claude-basic';

  try {
    // --- Step 1: Start session ---
    console.log('Starting Claude session with model "sonnet"...');
    const info = await manager.startSession({
      name: sessionName,
      engine: 'claude',
      model: 'sonnet',
    });

    if (info.status !== 'active') {
      printResult(TEST_NAME, false, `Expected status "active", got "${info.status}".`);
      return false;
    }
    console.log(`  Session started: engine=${info.engine}, model=${info.model}, status=${info.status}`);

    // --- Step 2: Send message ---
    console.log('Sending message: "Reply with exactly: INTEGRATION_OK"...');
    const result = await manager.sendMessage(
      sessionName,
      'Reply with exactly: INTEGRATION_OK',
    );

    console.log(`  Response: "${result.output.trim()}"`);
    console.log(`  Turn usage: tokens_in=${result.turnUsage.tokensIn}, tokens_out=${result.turnUsage.tokensOut}, cost=$${result.turnUsage.costUsd}`);

    const responseContainsMarker = result.output.includes('INTEGRATION_OK');
    if (!responseContainsMarker) {
      printResult(TEST_NAME, false, `Response did not contain "INTEGRATION_OK". Got: "${result.output.substring(0, 200)}"`);
      // Still try to stop
      await manager.stopSession(sessionName).catch(() => {});
      await manager.dispose();
      return false;
    }

    // --- Step 3: Check session status and cost tracking ---
    const sessionStatus = manager.getSessionStatus(sessionName);
    if (!sessionStatus) {
      printResult(TEST_NAME, false, 'getSessionStatus returned undefined for active session.');
      await manager.stopSession(sessionName).catch(() => {});
      await manager.dispose();
      return false;
    }

    const costTracked = sessionStatus.costUsd >= 0;
    const turnCountOk = sessionStatus.turnCount >= 1;
    console.log(`  Session cost: $${sessionStatus.costUsd}, turns: ${sessionStatus.turnCount}`);

    if (!costTracked) {
      printResult(TEST_NAME, false, `Cost tracking returned negative value: ${sessionStatus.costUsd}`);
      await manager.stopSession(sessionName).catch(() => {});
      await manager.dispose();
      return false;
    }

    if (!turnCountOk) {
      printResult(TEST_NAME, false, `Turn count should be >= 1, got ${sessionStatus.turnCount}`);
      await manager.stopSession(sessionName).catch(() => {});
      await manager.dispose();
      return false;
    }

    // --- Step 4: Stop session ---
    console.log('Stopping session...');
    await manager.stopSession(sessionName);

    const afterStop = manager.getSessionStatus(sessionName);
    // After stop, session is removed from active map; getSessionStatus may return undefined or stopped
    const stopOk = afterStop === undefined || afterStop.status === 'stopped';
    if (!stopOk) {
      printResult(TEST_NAME, false, `After stop, session status is "${afterStop?.status}" instead of stopped/removed.`);
      await manager.dispose();
      return false;
    }
    console.log('  Session stopped successfully.');

    await manager.dispose();

    printResult(TEST_NAME, true, 'Session lifecycle (start -> send -> verify -> stop) completed successfully.');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    printResult(TEST_NAME, false, `Unexpected error: ${msg}`);
    try {
      await manager.stopSession(sessionName).catch(() => {});
      await manager.dispose();
    } catch { /* best effort */ }
    return false;
  }
}

// Allow standalone execution and import from run-all
export { TEST_NAME };
export default run;

// Auto-run when executed directly
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('test-claude-session.ts');
if (isDirectRun) {
  run().then(ok => process.exit(ok ? 0 : 1));
}
