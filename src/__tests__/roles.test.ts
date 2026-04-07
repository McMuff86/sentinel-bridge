import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BUILT_IN_ROLES, RoleRegistry, validateRoleId } from '../orchestration/roles.js';
import { RoleStore } from '../orchestration/role-store.js';
import type { AgentRole } from '../orchestration/roles.js';

function makeRole(id: string, overrides?: Partial<AgentRole>): AgentRole {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    description: `Role: ${id}`,
    systemPrompt: `You are a ${id}.`,
    ...overrides,
  };
}

describe('RoleRegistry', () => {
  it('should include all built-in roles', () => {
    const registry = new RoleRegistry();
    const roles = registry.list();
    expect(roles.length).toBeGreaterThanOrEqual(4);
    expect(registry.has('architect')).toBe(true);
    expect(registry.has('implementer')).toBe(true);
    expect(registry.has('reviewer')).toBe(true);
    expect(registry.has('tester')).toBe(true);
  });

  it('should get a built-in role by id', () => {
    const registry = new RoleRegistry();
    const architect = registry.get('architect');
    expect(architect).toBeDefined();
    expect(architect!.id).toBe('architect');
    expect(architect!.systemPrompt).toBeTruthy();
  });

  it('should return undefined for unknown role', () => {
    const registry = new RoleRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('should register and retrieve custom roles', () => {
    const registry = new RoleRegistry();
    const custom = makeRole('devops', { preferredEngine: 'grok' });
    registry.register(custom);

    expect(registry.has('devops')).toBe(true);
    expect(registry.get('devops')!.preferredEngine).toBe('grok');
  });

  it('should not allow overriding built-in roles', () => {
    const registry = new RoleRegistry();
    expect(() => registry.register(makeRole('architect'))).toThrow('Cannot override built-in role');
  });

  it('should list both built-in and custom roles', () => {
    const registry = new RoleRegistry();
    registry.register(makeRole('devops'));
    const all = registry.list();
    const ids = all.map(r => r.id);
    expect(ids).toContain('architect');
    expect(ids).toContain('devops');
  });

  it('should initialize with pre-loaded custom roles', () => {
    const preloaded = [makeRole('custom1'), makeRole('custom2')];
    const registry = new RoleRegistry(preloaded);
    expect(registry.has('custom1')).toBe(true);
    expect(registry.has('custom2')).toBe(true);
  });

  it('should list only custom roles via listCustom()', () => {
    const registry = new RoleRegistry();
    registry.register(makeRole('devops'));
    const custom = registry.listCustom();
    expect(custom).toHaveLength(1);
    expect(custom[0].id).toBe('devops');
  });
});

describe('BUILT_IN_ROLES', () => {
  it('should have systemPrompt for all built-in roles', () => {
    for (const role of Object.values(BUILT_IN_ROLES)) {
      expect(role.systemPrompt).toBeTruthy();
      expect(role.name).toBeTruthy();
      expect(role.description).toBeTruthy();
    }
  });

  it('should have tags for all built-in roles', () => {
    for (const role of Object.values(BUILT_IN_ROLES)) {
      expect(role.tags).toBeDefined();
      expect(role.tags!.length).toBeGreaterThan(0);
    }
  });
});

describe('validateRoleId', () => {
  it('should accept valid ids', () => {
    expect(() => validateRoleId('architect')).not.toThrow();
    expect(() => validateRoleId('my-role')).not.toThrow();
    expect(() => validateRoleId('my_role')).not.toThrow();
    expect(() => validateRoleId('role123')).not.toThrow();
  });

  it('should reject empty ids', () => {
    expect(() => validateRoleId('')).toThrow('Invalid role id');
  });

  it('should reject ids starting with non-alphanumeric', () => {
    expect(() => validateRoleId('-bad')).toThrow('Invalid role id');
    expect(() => validateRoleId('_bad')).toThrow('Invalid role id');
  });

  it('should reject ids exceeding 64 chars', () => {
    const long = 'a' + 'x'.repeat(64);
    expect(() => validateRoleId(long)).toThrow('Invalid role id');
  });
});

describe('RoleStore', () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sb-roles-'));
    storePath = join(dir, 'roles.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('should persist and retrieve custom roles', () => {
    const store = new RoleStore(storePath);
    store.upsert(makeRole('devops'));

    const fresh = new RoleStore(storePath);
    const role = fresh.get('devops');
    expect(role).toBeDefined();
    expect(role!.id).toBe('devops');
  });

  it('should list all persisted roles', () => {
    const store = new RoleStore(storePath);
    store.upsert(makeRole('r1'));
    store.upsert(makeRole('r2'));
    expect(store.list()).toHaveLength(2);
  });

  it('should delete a role', () => {
    const store = new RoleStore(storePath);
    store.upsert(makeRole('r1'));
    store.delete('r1');
    expect(store.get('r1')).toBeUndefined();
  });

  it('should return empty list when no store file exists', () => {
    const store = new RoleStore(storePath);
    expect(store.list()).toEqual([]);
  });
});
