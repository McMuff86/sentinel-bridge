import { describe, it, expect } from 'vitest';
import { validateSessionName } from '../session-manager.js';

describe('validateSessionName', () => {
  it('accepts simple alphanumeric names', () => {
    expect(() => validateSessionName('alpha')).not.toThrow();
    expect(() => validateSessionName('session-1')).not.toThrow();
    expect(() => validateSessionName('my_session')).not.toThrow();
    expect(() => validateSessionName('Test Session')).not.toThrow();
  });

  it('accepts names up to 64 characters', () => {
    expect(() => validateSessionName('a'.repeat(64))).not.toThrow();
  });

  it('rejects empty strings', () => {
    expect(() => validateSessionName('')).toThrow(/Invalid session name/);
  });

  it('rejects names longer than 64 characters', () => {
    expect(() => validateSessionName('a'.repeat(65))).toThrow(/Invalid session name/);
  });

  it('rejects path traversal attempts', () => {
    expect(() => validateSessionName('../../etc/passwd')).toThrow(/Invalid session name/);
    expect(() => validateSessionName('../secret')).toThrow(/Invalid session name/);
  });

  it('rejects names with special characters', () => {
    expect(() => validateSessionName('name/with/slashes')).toThrow(/Invalid session name/);
    expect(() => validateSessionName('name:colon')).toThrow(/Invalid session name/);
    expect(() => validateSessionName('name\ttab')).toThrow(/Invalid session name/);
  });

  it('rejects names starting with special characters', () => {
    expect(() => validateSessionName('-starts-with-dash')).toThrow(/Invalid session name/);
    expect(() => validateSessionName('_starts-with-underscore')).toThrow(/Invalid session name/);
    expect(() => validateSessionName(' starts-with-space')).toThrow(/Invalid session name/);
  });
});
