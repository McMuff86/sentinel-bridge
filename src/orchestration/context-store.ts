import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ContextEntry {
  key: string;
  value: unknown;
  setBy: string;
  updatedAt: string;
}

export interface ContextStoreData {
  version: 1;
  workspace: string;
  entries: Record<string, ContextEntry>;
}

const CONTEXT_KEY_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9 _.:-]{0,127}$/;

function getDefaultContextDir(): string {
  const home = process?.env?.HOME ?? '/tmp';
  return join(home, '.openclaw', 'extensions', 'sentinel-bridge', 'state', 'context');
}

function sanitiseFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function validateContextKey(key: string): void {
  if (!CONTEXT_KEY_REGEX.test(key)) {
    throw new Error(
      `Invalid context key "${key}". ` +
      'Must be 1-128 characters: letters, digits, spaces, hyphens, underscores, dots, colons. ' +
      'Must start with a letter or digit.',
    );
  }
}

export class ContextStore {
  private readonly dir: string;

  constructor(dir = getDefaultContextDir()) {
    this.dir = dir;
  }

  set(workspace: string, key: string, value: unknown, setBy: string): ContextEntry {
    validateContextKey(key);

    // Validate JSON-serializable
    try {
      JSON.stringify(value);
    } catch {
      throw new Error(`Context value for key "${key}" is not JSON-serializable.`);
    }

    const data = this.load(workspace);
    const entry: ContextEntry = {
      key,
      value,
      setBy,
      updatedAt: new Date().toISOString(),
    };
    data.entries[key] = entry;
    this.save(data);
    return entry;
  }

  get(workspace: string, key: string): ContextEntry | undefined {
    return this.load(workspace).entries[key];
  }

  list(workspace: string): ContextEntry[] {
    return Object.values(this.load(workspace).entries);
  }

  delete(workspace: string, key: string): boolean {
    const data = this.load(workspace);
    if (!(key in data.entries)) return false;
    delete data.entries[key];
    this.save(data);
    return true;
  }

  clear(workspace: string): void {
    rmSync(this.pathFor(workspace), { force: true });
  }

  private load(workspace: string): ContextStoreData {
    const filePath = this.pathFor(workspace);
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as ContextStoreData;
      if (!parsed || parsed.version !== 1 || typeof parsed.entries !== 'object') {
        return { version: 1, workspace, entries: {} };
      }
      return parsed;
    } catch {
      // Main file missing or corrupt — try recovering from incomplete atomic write
      const tmpPath = filePath + '.tmp';
      if (existsSync(tmpPath)) {
        try {
          const raw = readFileSync(tmpPath, 'utf8');
          const parsed = JSON.parse(raw) as ContextStoreData;
          if (parsed?.version === 1 && typeof parsed.entries === 'object') {
            renameSync(tmpPath, filePath);
            return parsed;
          }
        } catch {
          // Temp file also corrupt — start fresh
        }
      }
      return { version: 1, workspace, entries: {} };
    }
  }

  private save(data: ContextStoreData): void {
    const filePath = this.pathFor(data.workspace);
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    renameSync(tmpPath, filePath);
  }

  private pathFor(workspace: string): string {
    return join(this.dir, `${sanitiseFileName(workspace)}.json`);
  }
}
