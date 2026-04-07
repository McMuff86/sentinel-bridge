#!/usr/bin/env npx tsx
/**
 * Integration test: circuit breaker behavior.
 *
 * Does NOT need any real engine. Tests the CircuitBreaker class directly
 * by recording failures and verifying state transitions.
 *
 * Run: npx tsx tests/integration/test-circuit-breaker.ts
 */

import { CircuitBreaker } from '../../src/orchestration/circuit-breaker.js';
import type { CircuitState } from '../../src/orchestration/circuit-breaker.js';
import { printResult } from './helpers.js';

const TEST_NAME = 'test-circuit-breaker';

function assertEqual<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function run(): Promise<boolean> {
  try {
    const threshold = 2;
    const cooldownMs = 500; // short cooldown for testing

    const breaker = new CircuitBreaker({
      failureThreshold: threshold,
      cooldownMs,
      halfOpenSuccessThreshold: 1,
    });

    // --- Step 1: Initial state is closed ---
    console.log('Step 1: Verify initial state is "closed"...');
    const initial = breaker.getSnapshot('grok');
    assertEqual('initial state', initial.state, 'closed' as CircuitState);
    assertEqual('initial failures', initial.consecutiveFailures, 0);
    console.log(`  State: ${initial.state}, consecutiveFailures: ${initial.consecutiveFailures}`);

    // --- Step 2: Record failures below threshold ---
    console.log('Step 2: Record 1 failure (below threshold of 2)...');
    breaker.recordFailure('grok');
    const afterOne = breaker.getSnapshot('grok');
    assertEqual('after 1 failure state', afterOne.state, 'closed' as CircuitState);
    assertEqual('after 1 failure count', afterOne.consecutiveFailures, 1);
    console.log(`  State: ${afterOne.state}, consecutiveFailures: ${afterOne.consecutiveFailures}`);

    // --- Step 3: Hit threshold -> circuit opens ---
    console.log('Step 3: Record 2nd failure (hits threshold)...');
    breaker.recordFailure('grok');
    const afterTwo = breaker.getSnapshot('grok');
    assertEqual('after threshold state', afterTwo.state, 'open' as CircuitState);
    assertEqual('after threshold failures', afterTwo.consecutiveFailures, 2);
    console.log(`  State: ${afterTwo.state}, consecutiveFailures: ${afterTwo.consecutiveFailures}`);

    // --- Step 4: Verify isAllowed returns false while open ---
    console.log('Step 4: Verify engine is blocked while circuit is open...');
    const allowed = breaker.isAllowed('grok');
    assertEqual('isAllowed while open', allowed, false);
    console.log(`  isAllowed: ${allowed}`);

    // --- Step 5: Other engines are unaffected ---
    console.log('Step 5: Verify other engines are unaffected...');
    const claudeAllowed = breaker.isAllowed('claude');
    assertEqual('claude isAllowed', claudeAllowed, true);
    console.log(`  claude isAllowed: ${claudeAllowed}`);

    // --- Step 6: Wait for cooldown, circuit transitions to half-open ---
    console.log(`Step 6: Wait ${cooldownMs}ms for cooldown, check half-open transition...`);
    await new Promise(resolve => setTimeout(resolve, cooldownMs + 50));
    const afterCooldown = breaker.getSnapshot('grok');
    assertEqual('after cooldown state', afterCooldown.state, 'half-open' as CircuitState);
    console.log(`  State: ${afterCooldown.state}`);

    // isAllowed should return true in half-open (probing)
    const halfOpenAllowed = breaker.isAllowed('grok');
    assertEqual('isAllowed in half-open', halfOpenAllowed, true);
    console.log(`  isAllowed (half-open): ${halfOpenAllowed}`);

    // --- Step 7: Success in half-open closes the circuit ---
    console.log('Step 7: Record success in half-open -> circuit closes...');
    breaker.recordSuccess('grok');
    const afterSuccess = breaker.getSnapshot('grok');
    assertEqual('after success state', afterSuccess.state, 'closed' as CircuitState);
    assertEqual('after success failures', afterSuccess.consecutiveFailures, 0);
    console.log(`  State: ${afterSuccess.state}, consecutiveFailures: ${afterSuccess.consecutiveFailures}`);

    // --- Step 8: Manual reset ---
    console.log('Step 8: Trip circuit again, then manual reset...');
    breaker.recordFailure('grok');
    breaker.recordFailure('grok');
    const tripped = breaker.getSnapshot('grok');
    assertEqual('tripped state', tripped.state, 'open' as CircuitState);

    breaker.reset('grok');
    const afterReset = breaker.getSnapshot('grok');
    assertEqual('after reset state', afterReset.state, 'closed' as CircuitState);
    assertEqual('after reset failures', afterReset.consecutiveFailures, 0);
    console.log(`  After reset: state=${afterReset.state}, consecutiveFailures=${afterReset.consecutiveFailures}`);

    // --- Step 9: Verify counters ---
    console.log('Step 9: Verify cumulative counters...');
    const finalSnapshot = breaker.getSnapshot('grok');
    // We had: 2 failures (open) + cooldown + 1 success (close) + 2 failures (open) + reset = 4 total failures, 1 total success
    assertEqual('totalFailures', finalSnapshot.totalFailures, 4);
    assertEqual('totalSuccesses', finalSnapshot.totalSuccesses, 1);
    console.log(`  totalFailures: ${finalSnapshot.totalFailures}, totalSuccesses: ${finalSnapshot.totalSuccesses}`);

    printResult(TEST_NAME, true, 'All circuit breaker state transitions verified (closed -> open -> half-open -> closed -> open -> reset -> closed).');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    printResult(TEST_NAME, false, msg);
    return false;
  }
}

export { TEST_NAME };
export default run;

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('test-circuit-breaker.ts');
if (isDirectRun) {
  run().then(ok => process.exit(ok ? 0 : 1));
}
