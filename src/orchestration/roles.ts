import type { EngineKind } from '../types.js';

export interface AgentRole {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  preferredEngine?: EngineKind;
  preferredModel?: string;
  tags?: string[];
}

const ROLE_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function validateRoleId(id: string): void {
  if (!ROLE_ID_REGEX.test(id)) {
    throw new Error(
      `Invalid role id "${id}". ` +
      'Must be 1-64 characters: letters, digits, hyphens, underscores. ' +
      'Must start with a letter or digit.',
    );
  }
}

export const BUILT_IN_ROLES: Record<string, AgentRole> = {
  architect: {
    id: 'architect',
    name: 'Architect',
    description: 'High-level system design, architecture decisions, and trade-off analysis.',
    systemPrompt:
      'You are an experienced software architect. Focus on high-level design, ' +
      'system architecture, and trade-off analysis. Evaluate approaches by ' +
      'scalability, maintainability, and correctness. Provide clear reasoning ' +
      'for architectural decisions. Do not write implementation code unless ' +
      'asked — instead, describe the structure, interfaces, and data flow.',
    preferredEngine: 'claude',
    tags: ['design', 'architecture', 'planning', 'trade-offs'],
  },
  implementer: {
    id: 'implementer',
    name: 'Implementer',
    description: 'Code generation, implementation, and pattern adherence.',
    systemPrompt:
      'You are a skilled software engineer focused on implementation. Write ' +
      'clean, correct, production-ready code that follows existing project ' +
      'patterns and conventions. Adhere to the established architecture. ' +
      'Include necessary error handling but avoid over-engineering. Focus on ' +
      'the task at hand without adding unrequested features.',
    tags: ['code', 'implementation', 'programming'],
  },
  reviewer: {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Code review, bug detection, security analysis, and quality assessment.',
    systemPrompt:
      'You are a meticulous code reviewer. Analyze code for bugs, security ' +
      'vulnerabilities, performance issues, and style problems. Categorize ' +
      'findings by severity (critical, warning, nit). Suggest specific fixes ' +
      'with code examples. Check for OWASP top 10, race conditions, resource ' +
      'leaks, and edge cases. Be thorough but constructive.',
    preferredEngine: 'claude',
    tags: ['review', 'security', 'quality', 'bugs'],
  },
  tester: {
    id: 'tester',
    name: 'Tester',
    description: 'Test strategy, test generation, edge case analysis, and coverage.',
    systemPrompt:
      'You are a testing specialist. Design comprehensive test strategies ' +
      'covering unit tests, integration tests, and edge cases. Write test ' +
      'code that is clear, maintainable, and well-structured. Focus on ' +
      'boundary conditions, error paths, and real-world failure scenarios. ' +
      'Aim for high coverage of critical paths.',
    tags: ['testing', 'quality', 'edge-cases', 'coverage'],
  },
};

const BUILT_IN_IDS = new Set(Object.keys(BUILT_IN_ROLES));

export class RoleRegistry {
  private readonly custom = new Map<string, AgentRole>();

  constructor(customRoles?: AgentRole[]) {
    if (customRoles) {
      for (const role of customRoles) {
        this.custom.set(role.id, role);
      }
    }
  }

  register(role: AgentRole): void {
    validateRoleId(role.id);
    if (BUILT_IN_IDS.has(role.id)) {
      throw new Error(
        `Cannot override built-in role "${role.id}". Use a different id for custom roles.`,
      );
    }
    this.custom.set(role.id, role);
  }

  get(id: string): AgentRole | undefined {
    return BUILT_IN_ROLES[id] ?? this.custom.get(id);
  }

  has(id: string): boolean {
    return BUILT_IN_IDS.has(id) || this.custom.has(id);
  }

  list(): AgentRole[] {
    const all = new Map<string, AgentRole>();
    for (const [id, role] of Object.entries(BUILT_IN_ROLES)) {
      all.set(id, role);
    }
    for (const [id, role] of this.custom) {
      all.set(id, role);
    }
    return Array.from(all.values());
  }

  listCustom(): AgentRole[] {
    return Array.from(this.custom.values());
  }
}
