#!/usr/bin/env npx tsx
/**
 * Integration test runner — executes all integration tests in sequence
 * and prints a summary.
 *
 * Run: npx tsx tests/integration/run-all.ts
 */

import runContextBlackboard, { TEST_NAME as CTX_NAME } from './test-context-blackboard.js';
import runCircuitBreaker, { TEST_NAME as CB_NAME } from './test-circuit-breaker.js';
import runClaudeSession, { TEST_NAME as CLAUDE_NAME } from './test-claude-session.js';
import runWorkflowPipeline, { TEST_NAME as WF_NAME } from './test-workflow-pipeline.js';
import runRelay, { TEST_NAME as RELAY_NAME } from './test-relay.js';

interface TestEntry {
  name: string;
  run: () => Promise<boolean>;
}

const tests: TestEntry[] = [
  // Tests that don't need real engines go first
  { name: CTX_NAME, run: runContextBlackboard },
  { name: CB_NAME, run: runCircuitBreaker },
  // Tests that need real engines
  { name: CLAUDE_NAME, run: runClaudeSession },
  { name: WF_NAME, run: runWorkflowPipeline },
  { name: RELAY_NAME, run: runRelay },
];

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  sentinel-bridge integration tests');
  console.log('='.repeat(60));

  const results: { name: string; passed: boolean; durationMs: number }[] = [];

  for (const test of tests) {
    console.log('\n' + '-'.repeat(60));
    console.log(`Running: ${test.name}`);
    console.log('-'.repeat(60));

    const start = Date.now();
    let passed = false;
    try {
      passed = await test.run();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`[FAIL] ${test.name}`);
      console.log(`       Unhandled error: ${msg}`);
      passed = false;
    }
    const durationMs = Date.now() - start;

    results.push({ name: test.name, passed, durationMs });
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('  SUMMARY');
  console.log('='.repeat(60));

  const maxNameLen = Math.max(...results.map(r => r.name.length));

  for (const r of results) {
    const tag = r.passed ? 'PASS' : 'FAIL';
    const pad = ' '.repeat(maxNameLen - r.name.length);
    const duration = (r.durationMs / 1000).toFixed(1);
    console.log(`  [${tag}] ${r.name}${pad}  (${duration}s)`);
  }

  const passCount = results.filter(r => r.passed).length;
  const failCount = results.filter(r => !r.passed).length;
  const totalDuration = (results.reduce((s, r) => s + r.durationMs, 0) / 1000).toFixed(1);

  console.log('');
  console.log(`  Total: ${results.length}  Passed: ${passCount}  Failed: ${failCount}  Duration: ${totalDuration}s`);
  console.log('='.repeat(60));

  process.exit(failCount > 0 ? 1 : 0);
}

main();
