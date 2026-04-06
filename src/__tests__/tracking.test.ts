import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { UsageTracker, usageTracker } from '../tracking.js';

const tempDirectories: string[] = [];

interface FsPromisesModule {
  mkdtemp(prefix: string): Promise<string>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
}

afterEach(async () => {
  const fs = await loadFsPromises();

  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('UsageTracker', () => {
  it('should export a singleton instance', () => {
    expect(usageTracker).toBeInstanceOf(UsageTracker);
  });

  it('should append normalized JSONL entries to the configured log file', async () => {
    const { tracker, logFilePath } = await createTracker();

    await tracker.logCall({
      timestamp: '2026-04-04T10:00:00+02:00',
      sessionName: 'alpha',
      engine: 'claude',
      model: 'claude-opus-4-6',
      action: 'send',
      tokens: {
        input: 100,
        output: 50,
        cachedInput: 25,
        total: 999,
      },
      costUsd: 1.23456789,
      subscriptionCovered: true,
      durationMs: 1500,
    });

    const fs = await loadFsPromises();
    const contents = await fs.readFile(logFilePath, 'utf8');
    const lines = contents.trim().split('\n');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      timestamp: '2026-04-04T08:00:00.000Z',
      sessionName: 'alpha',
      engine: 'claude',
      model: 'claude-opus-4-6',
      action: 'send',
      tokens: {
        input: 100,
        output: 50,
        cachedInput: 25,
        total: 175,
      },
      costUsd: 1.234568,
      subscriptionCovered: true,
      durationMs: 1500,
    });
  });

  it('should aggregate session, engine, daily, and subscription summaries', async () => {
    const { tracker } = await createTracker(
      () => new Date('2026-04-04T15:30:00.000Z'),
    );

    await tracker.logCall({
      timestamp: '2026-04-04T10:00:00.000Z',
      sessionName: 'alpha',
      engine: 'claude',
      model: 'claude-opus-4-6',
      action: 'start',
      subscriptionCovered: true,
      durationMs: 200,
    });
    await tracker.logCall({
      timestamp: '2026-04-04T10:05:00.000Z',
      sessionName: 'alpha',
      engine: 'claude',
      model: 'claude-opus-4-6',
      action: 'send',
      tokens: {
        input: 100,
        output: 50,
        cachedInput: 10,
        total: 160,
      },
      costUsd: 0.32,
      subscriptionCovered: true,
      durationMs: 1200,
    });
    await tracker.logCall({
      timestamp: '2026-04-04T11:00:00.000Z',
      sessionName: 'alpha',
      engine: 'claude',
      model: 'claude-opus-4-6',
      action: 'compact',
      tokens: {
        input: 50,
        output: 20,
        cachedInput: 0,
        total: 70,
      },
      costUsd: 0.11,
      subscriptionCovered: true,
      durationMs: 500,
    });
    await tracker.logCall({
      timestamp: '2026-04-04T12:00:00.000Z',
      sessionName: 'beta',
      engine: 'codex',
      model: 'gpt-5.4',
      action: 'send',
      tokens: {
        input: 40,
        output: 60,
        cachedInput: 0,
        total: 100,
      },
      costUsd: 0.45,
      subscriptionCovered: false,
      durationMs: 900,
      error: 'rate limited',
    });
    await tracker.logCall({
      timestamp: '2026-04-05T00:15:00.000Z',
      sessionName: 'gamma',
      engine: 'grok',
      model: 'grok-4-1-fast',
      action: 'stop',
      subscriptionCovered: false,
      durationMs: 100,
    });

    await expect(tracker.getSessionSummary('alpha')).resolves.toEqual({
      sessionName: 'alpha',
      entryCount: 3,
      sessionCount: 1,
      totalCostUsd: 0.43,
      totalDurationMs: 1900,
      totalTokens: {
        input: 150,
        output: 70,
        cachedInput: 10,
        total: 230,
      },
      coveredCostUsd: 0.43,
      uncoveredCostUsd: 0,
      coveredEntryCount: 3,
      uncoveredEntryCount: 0,
      errorCount: 0,
      actionCounts: {
        start: 1,
        send: 1,
        compact: 1,
        stop: 0,
      },
      firstTimestamp: '2026-04-04T10:00:00.000Z',
      lastTimestamp: '2026-04-04T11:00:00.000Z',
    });

    await expect(tracker.getEngineSummary('codex')).resolves.toEqual({
      engine: 'codex',
      entryCount: 1,
      sessionCount: 1,
      totalCostUsd: 0.45,
      totalDurationMs: 900,
      totalTokens: {
        input: 40,
        output: 60,
        cachedInput: 0,
        total: 100,
      },
      coveredCostUsd: 0,
      uncoveredCostUsd: 0.45,
      coveredEntryCount: 0,
      uncoveredEntryCount: 1,
      errorCount: 1,
      actionCounts: {
        start: 0,
        send: 1,
        compact: 0,
        stop: 0,
      },
      firstTimestamp: '2026-04-04T12:00:00.000Z',
      lastTimestamp: '2026-04-04T12:00:00.000Z',
    });

    await expect(tracker.getDailySummary()).resolves.toEqual({
      date: '2026-04-04',
      entryCount: 4,
      sessionCount: 2,
      totalCostUsd: 0.88,
      totalDurationMs: 2800,
      totalTokens: {
        input: 190,
        output: 130,
        cachedInput: 10,
        total: 330,
      },
      coveredCostUsd: 0.43,
      uncoveredCostUsd: 0.45,
      coveredEntryCount: 3,
      uncoveredEntryCount: 1,
      errorCount: 1,
      actionCounts: {
        start: 1,
        send: 2,
        compact: 1,
        stop: 0,
      },
      firstTimestamp: '2026-04-04T10:00:00.000Z',
      lastTimestamp: '2026-04-04T12:00:00.000Z',
    });

    await expect(tracker.getDailySummary('2026-04-05')).resolves.toEqual({
      date: '2026-04-05',
      entryCount: 1,
      sessionCount: 1,
      totalCostUsd: 0,
      totalDurationMs: 100,
      totalTokens: {
        input: 0,
        output: 0,
        cachedInput: 0,
        total: 0,
      },
      coveredCostUsd: 0,
      uncoveredCostUsd: 0,
      coveredEntryCount: 0,
      uncoveredEntryCount: 1,
      errorCount: 0,
      actionCounts: {
        start: 0,
        send: 0,
        compact: 0,
        stop: 1,
      },
      firstTimestamp: '2026-04-05T00:15:00.000Z',
      lastTimestamp: '2026-04-05T00:15:00.000Z',
    });

    await expect(tracker.getSubscriptionSavings()).resolves.toEqual({
      totalTrackedCostUsd: 0.88,
      totalSavedUsd: 0.43,
      totalDirectCostUsd: 0.45,
      coveredEntryCount: 3,
      uncoveredEntryCount: 2,
      byEngine: {
        claude: 0.43,
        codex: 0,
        grok: 0,
        ollama: 0,
      },
    });
  });
});

async function createTracker(now?: () => Date): Promise<{
  tracker: UsageTracker;
  logFilePath: string;
}> {
  const fs = await loadFsPromises();
  const directory = await fs.mkdtemp(
    resolve(getTempDirectory(), 'sentinel-bridge-tracking-'),
  );
  tempDirectories.push(directory);

  const logFilePath = resolve(directory, 'usage.jsonl');
  const tracker = new UsageTracker({
    logFilePath,
    now,
  });

  return {
    tracker,
    logFilePath,
  };
}

function getTempDirectory(): string {
  return process?.env?.TMPDIR ?? process?.env?.TEMP ?? process?.env?.TMP ?? '/tmp';
}

async function loadFsPromises(): Promise<FsPromisesModule> {
  const moduleName = 'node:fs/promises';
  return import(moduleName) as Promise<FsPromisesModule>;
}
