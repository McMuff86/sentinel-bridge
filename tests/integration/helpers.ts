/**
 * Shared helpers for integration tests.
 */

import { execFileSync } from 'node:child_process';

export function printResult(testName: string, passed: boolean, details: string): void {
  const tag = passed ? 'PASS' : 'FAIL';
  console.log(`\n[${ tag }] ${ testName }`);
  if (details) {
    console.log(`       ${ details }`);
  }
}

export function printSkip(testName: string, reason: string): void {
  console.log(`\n[SKIP] ${ testName }`);
  console.log(`       ${ reason }`);
}

/**
 * Check whether the Claude CLI binary is reachable on PATH.
 * Returns true if `claude --version` exits successfully.
 */
export function isClaudeCliAvailable(): boolean {
  try {
    execFileSync('claude', ['--version'], {
      stdio: 'pipe',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}
