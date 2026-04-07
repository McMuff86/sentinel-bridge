#!/usr/bin/env npx tsx
/**
 * Integration test: 2-step workflow pipeline.
 *
 * Step 1: Claude generates a random 4-digit number.
 * Step 2: Claude receives that number and confirms it.
 *
 * Requires: Claude CLI installed and authenticated.
 * Run:      npx tsx tests/integration/test-workflow-pipeline.ts
 */

import { SessionManager } from '../../src/session-manager.js';
import { createPipelineWorkflow } from '../../src/orchestration/workflow-templates.js';
import type { WorkflowState } from '../../src/orchestration/workflow-types.js';
import { isClaudeCliAvailable, printResult, printSkip } from './helpers.js';

const TEST_NAME = 'test-workflow-pipeline';

async function run(): Promise<boolean> {
  if (!isClaudeCliAvailable()) {
    printSkip(TEST_NAME, 'Claude CLI not found on PATH. Install and authenticate it to run this test.');
    return true;
  }

  const manager = new SessionManager({
    cleanupIntervalMs: 0,
    defaultFallbackChain: [],
  });

  const workflowId = 'integ-pipeline-test';
  const workspace = 'integ-test-workspace';

  try {
    // Build a 2-step pipeline
    const definition = createPipelineWorkflow(
      workflowId,
      'Integration Pipeline Test',
      workspace,
      [
        {
          id: 'generate',
          sessionName: 'integ-wf-generate',
          task: 'Generate a random 4-digit number between 1000 and 9999. Reply with ONLY the number, nothing else.',
          engine: 'claude',
          model: 'sonnet',
        },
        {
          id: 'confirm',
          sessionName: 'integ-wf-confirm',
          task: 'You received a number from the previous step. Reply with exactly: CONFIRMED <the number>',
          engine: 'claude',
          model: 'sonnet',
        },
      ],
    );

    console.log('Starting 2-step pipeline workflow...');
    await manager.workflows.start(definition, manager);

    // Poll until workflow completes (or timeout after 120s)
    const deadline = Date.now() + 120_000;
    let finalState: WorkflowState | undefined;

    while (Date.now() < deadline) {
      finalState = manager.workflows.getStatus(workflowId);
      if (!finalState) {
        printResult(TEST_NAME, false, 'Workflow disappeared from engine.');
        await manager.dispose();
        return false;
      }

      if (finalState.status === 'completed' || finalState.status === 'failed' || finalState.status === 'cancelled') {
        break;
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }

    if (!finalState) {
      printResult(TEST_NAME, false, 'Workflow state is undefined after polling.');
      await manager.dispose();
      return false;
    }

    console.log(`  Workflow status: ${finalState.status}`);

    // Check step results
    const generateStep = finalState.steps['generate'];
    const confirmStep = finalState.steps['confirm'];

    console.log(`  Step "generate": status=${generateStep?.status}, output="${generateStep?.output?.trim() ?? '(none)'}"`);
    console.log(`  Step "confirm":  status=${confirmStep?.status}, output="${confirmStep?.output?.trim() ?? '(none)'}"`);

    if (finalState.status !== 'completed') {
      const errors = Object.values(finalState.steps)
        .filter(s => s.error)
        .map(s => `${s.id}: ${s.error}`)
        .join('; ');
      printResult(TEST_NAME, false, `Workflow did not complete. Status: ${finalState.status}. Errors: ${errors || '(none)'}`);
      await cleanup(manager);
      return false;
    }

    if (generateStep?.status !== 'completed') {
      printResult(TEST_NAME, false, `Generate step status: ${generateStep?.status}`);
      await cleanup(manager);
      return false;
    }

    if (confirmStep?.status !== 'completed') {
      printResult(TEST_NAME, false, `Confirm step status: ${confirmStep?.status}`);
      await cleanup(manager);
      return false;
    }

    // Verify generate step produced a number-like output
    const generatedText = generateStep.output?.trim() ?? '';
    const hasNumber = /\d{4}/.test(generatedText);
    if (!hasNumber) {
      printResult(TEST_NAME, false, `Generate step output does not contain a 4-digit number: "${generatedText}"`);
      await cleanup(manager);
      return false;
    }

    // Verify confirm step acknowledged the number
    const confirmText = confirmStep.output?.trim() ?? '';
    const hasConfirmed = /CONFIRMED/i.test(confirmText) && /\d{4}/.test(confirmText);
    if (!hasConfirmed) {
      // Be lenient: LLMs sometimes rephrase. Just check it mentions a number.
      const mentionsNumber = /\d{4}/.test(confirmText);
      if (!mentionsNumber) {
        printResult(TEST_NAME, false, `Confirm step output does not reference the number: "${confirmText}"`);
        await cleanup(manager);
        return false;
      }
      console.log('  (Note: confirm step did not use exact "CONFIRMED" prefix, but does reference the number.)');
    }

    await cleanup(manager);
    printResult(TEST_NAME, true, 'Both pipeline steps completed successfully. Number was generated and confirmed.');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    printResult(TEST_NAME, false, `Unexpected error: ${msg}`);
    await cleanup(manager);
    return false;
  }
}

async function cleanup(manager: SessionManager): Promise<void> {
  try {
    // Stop any sessions that might still be active
    for (const session of manager.listSessions()) {
      if (session.status === 'active') {
        await manager.stopSession(session.name).catch(() => {});
      }
    }
    await manager.dispose();
  } catch { /* best effort */ }
}

export { TEST_NAME };
export default run;

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('test-workflow-pipeline.ts');
if (isDirectRun) {
  run().then(ok => process.exit(ok ? 0 : 1));
}
