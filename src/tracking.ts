import { resolve } from 'node:path';

import type { EngineKind, TokenUsage } from './types.js';

export type UsageAction = 'start' | 'send' | 'compact' | 'stop';

export interface UsageLogEntry {
  timestamp: string;
  sessionName: string;
  engine: 'claude' | 'codex' | 'grok' | 'ollama';
  model: string;
  action: 'start' | 'send' | 'compact' | 'stop';
  tokens?: { input: number; output: number; cachedInput: number; total: number };
  costUsd?: number;
  subscriptionCovered: boolean;
  durationMs?: number;
  error?: string;
}

export interface UsageLogInput {
  timestamp?: string;
  sessionName: string;
  engine: EngineKind;
  model: string;
  action: UsageAction;
  tokens?: TokenUsage;
  costUsd?: number;
  subscriptionCovered: boolean;
  durationMs?: number;
  error?: string;
}

export interface UsageTrackerOptions {
  logFilePath?: string;
  now?: () => Date;
}

export interface UsageSummary {
  entryCount: number;
  sessionCount: number;
  totalCostUsd: number;
  totalDurationMs: number;
  totalTokens: TokenUsage;
  coveredCostUsd: number;
  uncoveredCostUsd: number;
  coveredEntryCount: number;
  uncoveredEntryCount: number;
  errorCount: number;
  actionCounts: Record<UsageAction, number>;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}

export interface SessionUsageSummary extends UsageSummary {
  sessionName: string;
}

export interface EngineUsageSummary extends UsageSummary {
  engine: EngineKind;
}

export interface DailyUsageSummary extends UsageSummary {
  date: string;
}

export interface SubscriptionSavingsSummary {
  totalTrackedCostUsd: number;
  totalSavedUsd: number;
  totalDirectCostUsd: number;
  coveredEntryCount: number;
  uncoveredEntryCount: number;
  byEngine: Record<EngineKind, number>;
}

const DEFAULT_USAGE_LOG_PATH = join(
  getHomeDirectory(),
  '.sentinel-bridge',
  'usage.jsonl',
);

interface FsPromisesModule {
  appendFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<string | undefined>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}

export class UsageTracker {
  private readonly logFilePath: string;
  private readonly now: () => Date;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(options: UsageTrackerOptions = {}) {
    this.logFilePath = resolveLogFilePath(options.logFilePath);
    this.now = options.now ?? (() => new Date());
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }

  async logCall(entry: UsageLogInput): Promise<UsageLogEntry> {
    const normalizedEntry = normalizeUsageLogEntry(entry, this.now);
    const line = `${JSON.stringify(normalizedEntry)}\n`;

    const writeOperation = async (): Promise<void> => {
      try {
        const fs = await loadFsPromises();
        await fs.mkdir(resolve(this.logFilePath, '..'), { recursive: true });
        await fs.appendFile(this.logFilePath, line, 'utf8');
      } catch (error) {
        throw wrapError(
          `Failed to write usage entry for session "${normalizedEntry.sessionName}" ` +
            `on engine "${normalizedEntry.engine}"`,
          error,
        );
      }
    };

    const currentWrite = this.pendingWrite.then(writeOperation, writeOperation);
    this.pendingWrite = currentWrite.catch(() => undefined);
    await currentWrite;

    return normalizedEntry;
  }

  async getSessionSummary(name: string): Promise<SessionUsageSummary> {
    const sessionName = requireNonEmptyString(name, 'Session summary name');
    const entries = await this.loadEntries(
      (entry) => entry.sessionName === sessionName,
    );

    return {
      sessionName,
      ...summarizeEntries(entries),
    };
  }

  async getEngineSummary(engine: EngineKind): Promise<EngineUsageSummary> {
    const normalizedEngine = requireEngineKind(engine, 'Engine summary engine');
    const entries = await this.loadEntries(
      (entry) => entry.engine === normalizedEngine,
    );

    return {
      engine: normalizedEngine,
      ...summarizeEntries(entries),
    };
  }

  async getDailySummary(date?: string | Date): Promise<DailyUsageSummary> {
    const day = normalizeDateKey(date ?? this.now(), 'Daily summary date');
    const entries = await this.loadEntries(
      (entry) => entry.timestamp.slice(0, 10) === day,
    );

    return {
      date: day,
      ...summarizeEntries(entries),
    };
  }

  async getSubscriptionSavings(): Promise<SubscriptionSavingsSummary> {
    const entries = await this.loadEntries();
    const byEngine = createEmptyEngineCosts();

    let totalSavedUsd = 0;
    let totalDirectCostUsd = 0;
    let coveredEntryCount = 0;
    let uncoveredEntryCount = 0;

    for (const entry of entries) {
      const costUsd = entry.costUsd ?? 0;

      if (entry.subscriptionCovered) {
        coveredEntryCount += 1;
        totalSavedUsd += costUsd;
        byEngine[entry.engine] = roundUsd(byEngine[entry.engine] + costUsd);
      } else {
        uncoveredEntryCount += 1;
        totalDirectCostUsd += costUsd;
      }
    }

    return {
      totalTrackedCostUsd: roundUsd(totalSavedUsd + totalDirectCostUsd),
      totalSavedUsd: roundUsd(totalSavedUsd),
      totalDirectCostUsd: roundUsd(totalDirectCostUsd),
      coveredEntryCount,
      uncoveredEntryCount,
      byEngine,
    };
  }

  private async loadEntries(
    filter?: (entry: UsageLogEntry) => boolean,
  ): Promise<UsageLogEntry[]> {
    await this.pendingWrite;

    let contents: string;
    try {
      const fs = await loadFsPromises();
      contents = await fs.readFile(this.logFilePath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }

      throw wrapError(
        `Failed to read usage log from "${this.logFilePath}"`,
        error,
      );
    }

    const entries: UsageLogEntry[] = [];
    const lines = contents.split('\n');

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw wrapError(
          `Failed to parse usage log line ${index + 1} in "${this.logFilePath}"`,
          error,
        );
      }

      const entry = parseStoredUsageLogEntry(parsed, index + 1);
      if (!filter || filter(entry)) {
        entries.push(entry);
      }
    }

    return entries;
  }
}

export const usageTracker = new UsageTracker();

export default usageTracker;

function createEmptySummary(): UsageSummary {
  return {
    entryCount: 0,
    sessionCount: 0,
    totalCostUsd: 0,
    totalDurationMs: 0,
    totalTokens: createEmptyTokenUsage(),
    coveredCostUsd: 0,
    uncoveredCostUsd: 0,
    coveredEntryCount: 0,
    uncoveredEntryCount: 0,
    errorCount: 0,
    actionCounts: createEmptyActionCounts(),
    firstTimestamp: null,
    lastTimestamp: null,
  };
}

function summarizeEntries(entries: UsageLogEntry[]): UsageSummary {
  const summary = createEmptySummary();
  const sessionNames = new Set<string>();

  for (const entry of entries) {
    summary.entryCount += 1;
    sessionNames.add(entry.sessionName);
    summary.totalTokens = mergeTokenUsage(summary.totalTokens, entry.tokens);
    summary.totalDurationMs += entry.durationMs ?? 0;
    summary.actionCounts[entry.action] += 1;

    if (entry.error) {
      summary.errorCount += 1;
    }

    if (!summary.firstTimestamp || entry.timestamp < summary.firstTimestamp) {
      summary.firstTimestamp = entry.timestamp;
    }

    if (!summary.lastTimestamp || entry.timestamp > summary.lastTimestamp) {
      summary.lastTimestamp = entry.timestamp;
    }

    const costUsd = entry.costUsd ?? 0;
    summary.totalCostUsd += costUsd;

    if (entry.subscriptionCovered) {
      summary.coveredEntryCount += 1;
      summary.coveredCostUsd += costUsd;
    } else {
      summary.uncoveredEntryCount += 1;
      summary.uncoveredCostUsd += costUsd;
    }
  }

  summary.sessionCount = sessionNames.size;
  summary.totalCostUsd = roundUsd(summary.totalCostUsd);
  summary.coveredCostUsd = roundUsd(summary.coveredCostUsd);
  summary.uncoveredCostUsd = roundUsd(summary.uncoveredCostUsd);

  return summary;
}

function normalizeUsageLogEntry(
  entry: UsageLogInput,
  now: () => Date,
): UsageLogEntry {
  const timestampSource = entry.timestamp ?? now().toISOString();

  return {
    timestamp: normalizeTimestamp(timestampSource, 'Usage log entry timestamp'),
    sessionName: requireNonEmptyString(
      entry.sessionName,
      'Usage log entry sessionName',
    ),
    engine: requireEngineKind(entry.engine, 'Usage log entry engine'),
    model: requireNonEmptyString(entry.model, 'Usage log entry model'),
    action: requireAction(entry.action, 'Usage log entry action'),
    tokens: normalizeTokenUsage(entry.tokens, 'Usage log entry tokens'),
    costUsd: normalizeOptionalMoney(entry.costUsd, 'Usage log entry costUsd'),
    subscriptionCovered: requireBoolean(
      entry.subscriptionCovered,
      'Usage log entry subscriptionCovered',
    ),
    durationMs: normalizeOptionalDuration(
      entry.durationMs,
      'Usage log entry durationMs',
    ),
    error: normalizeOptionalString(entry.error),
  };
}

function parseStoredUsageLogEntry(
  value: unknown,
  lineNumber: number,
): UsageLogEntry {
  if (!isRecord(value)) {
    throw new Error(`Usage log line ${lineNumber} must contain a JSON object.`);
  }

  return {
    timestamp: normalizeTimestamp(
      value.timestamp,
      `Usage log line ${lineNumber} timestamp`,
    ),
    sessionName: requireNonEmptyString(
      value.sessionName,
      `Usage log line ${lineNumber} sessionName`,
    ),
    engine: requireEngineKind(value.engine, `Usage log line ${lineNumber} engine`),
    model: requireNonEmptyString(
      value.model,
      `Usage log line ${lineNumber} model`,
    ),
    action: requireAction(value.action, `Usage log line ${lineNumber} action`),
    tokens: normalizeTokenUsage(
      value.tokens,
      `Usage log line ${lineNumber} tokens`,
    ),
    costUsd: normalizeOptionalMoney(
      value.costUsd,
      `Usage log line ${lineNumber} costUsd`,
    ),
    subscriptionCovered: requireBoolean(
      value.subscriptionCovered,
      `Usage log line ${lineNumber} subscriptionCovered`,
    ),
    durationMs: normalizeOptionalDuration(
      value.durationMs,
      `Usage log line ${lineNumber} durationMs`,
    ),
    error: normalizeOptionalString(value.error),
  };
}

function resolveLogFilePath(logFilePath?: string): string {
  const filePath = logFilePath?.trim() ? logFilePath.trim() : DEFAULT_USAGE_LOG_PATH;
  return resolve(expandHomeDirectory(filePath));
}

function expandHomeDirectory(filePath: string): string {
  if (filePath === '~') {
    return getHomeDirectory();
  }

  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return resolve(getHomeDirectory(), filePath.slice(2));
  }

  return filePath;
}

function join(...paths: string[]): string {
  return resolve(...paths);
}

function getHomeDirectory(): string {
  const homeDirectory =
    process?.env?.HOME ??
    process?.env?.USERPROFILE ??
    getWindowsHomeDirectory();

  return homeDirectory ? resolve(homeDirectory) : resolve('.');
}

function getWindowsHomeDirectory(): string | null {
  const homeDrive = process?.env?.HOMEDRIVE;
  const homePath = process?.env?.HOMEPATH;

  if (!homeDrive || !homePath) {
    return null;
  }

  return `${homeDrive}${homePath}`;
}

async function loadFsPromises(): Promise<FsPromisesModule> {
  const moduleName = 'node:fs/promises';
  return import(moduleName) as Promise<FsPromisesModule>;
}

function createEmptyTokenUsage(): TokenUsage {
  return {
    input: 0,
    output: 0,
    cachedInput: 0,
    total: 0,
  };
}

function mergeTokenUsage(
  current: TokenUsage,
  next?: TokenUsage,
): TokenUsage {
  if (!next) {
    return { ...current };
  }

  const input = current.input + next.input;
  const output = current.output + next.output;
  const cachedInput = current.cachedInput + next.cachedInput;

  return {
    input,
    output,
    cachedInput,
    total: input + output + cachedInput,
  };
}

function createEmptyActionCounts(): Record<UsageAction, number> {
  return {
    start: 0,
    send: 0,
    compact: 0,
    stop: 0,
  };
}

function createEmptyEngineCosts(): Record<EngineKind, number> {
  return {
    claude: 0,
    codex: 0,
    grok: 0,
  };
}

function normalizeDateKey(value: string | Date, context: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`${context} must be a valid date.`);
    }

    return value.toISOString().slice(0, 10);
  }

  const trimmedValue = requireNonEmptyString(value, context);
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedValue)) {
    return trimmedValue;
  }

  const parsed = new Date(trimmedValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `${context} must be a YYYY-MM-DD string or a valid ISO date string.`,
    );
  }

  return parsed.toISOString().slice(0, 10);
}

function normalizeTimestamp(value: unknown, context: string): string {
  const timestamp = requireNonEmptyString(value, context);
  const parsed = new Date(timestamp);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${context} must be a valid ISO timestamp.`);
  }

  return parsed.toISOString();
}

function normalizeTokenUsage(
  value: unknown,
  context: string,
): TokenUsage | undefined {
  if (value == null) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  const input = requireNonNegativeNumber(value.input, `${context}.input`);
  const output = requireNonNegativeNumber(value.output, `${context}.output`);
  const cachedInput = requireNonNegativeNumber(
    value.cachedInput,
    `${context}.cachedInput`,
  );

  return {
    input,
    output,
    cachedInput,
    total: input + output + cachedInput,
  };
}

function normalizeOptionalMoney(
  value: unknown,
  context: string,
): number | undefined {
  if (value == null) {
    return undefined;
  }

  return roundUsd(requireNonNegativeNumber(value, context));
}

function normalizeOptionalDuration(
  value: unknown,
  context: string,
): number | undefined {
  if (value == null) {
    return undefined;
  }

  return requireNonNegativeNumber(value, context);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function requireNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a non-empty string.`);
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    throw new Error(`${context} must be a non-empty string.`);
  }

  return trimmedValue;
}

function requireNonNegativeNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${context} must be a non-negative number.`);
  }

  return value;
}

function requireBoolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${context} must be a boolean.`);
  }

  return value;
}

function requireEngineKind(value: unknown, context: string): EngineKind {
  if (value === 'claude' || value === 'codex' || value === 'grok') {
    return value;
  }

  throw new Error(`${context} must be "claude", "codex", or "grok".`);
}

function requireAction(value: unknown, context: string): UsageAction {
  if (
    value === 'start' ||
    value === 'send' ||
    value === 'compact' ||
    value === 'stop'
  ) {
    return value;
  }

  throw new Error(`${context} must be "start", "send", "compact", or "stop".`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  return (
    isRecord(error) &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === 'ENOENT'
  );
}

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function wrapError(context: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${context}: ${message}`, { cause: error });
}
