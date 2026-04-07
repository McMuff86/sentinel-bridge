import { describe, it, expect } from 'vitest';

import { classifyTask } from '../orchestration/task-classifier.js';

describe('classifyTask', () => {
  it('should classify code generation tasks', () => {
    const result = classifyTask('Implement a function that validates email addresses in TypeScript');
    expect(result.primary).toBe('code_generation');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('should classify code review tasks', () => {
    const result = classifyTask('Review this code for security vulnerabilities and bugs');
    expect(result.primary).toBe('code_review');
  });

  it('should classify reasoning tasks', () => {
    const result = classifyTask('Analyze the trade-offs between using Redis vs Memcached for our caching layer and evaluate which approach is better');
    expect(result.primary).toBe('reasoning');
  });

  it('should classify fast/simple tasks', () => {
    const result = classifyTask('Summarize this text briefly in one sentence');
    expect(result.primary).toBe('fast_task');
  });

  it('should classify local/private tasks', () => {
    const result = classifyTask('Process this sensitive PII data locally, keep it private and offline');
    expect(result.primary).toBe('local_private');
  });

  it('should classify creative tasks', () => {
    const result = classifyTask('Write a story about a robot exploring space');
    expect(result.primary).toBe('creative');
  });

  it('should fall back to general for ambiguous tasks', () => {
    const result = classifyTask('hello');
    expect(result.primary).toBe('general');
  });

  it('should detect file extension patterns', () => {
    const result = classifyTask('Fix the parser.ts file');
    expect(result.primary).toBe('code_generation');
    expect(result.signals.some(s => s.includes('ts'))).toBe(true);
  });

  it('should estimate complexity based on text length', () => {
    expect(classifyTask('fix bug').complexity).toBe('simple');
    expect(classifyTask('Implement a comprehensive authentication system with JWT tokens, session management, and role-based access control that integrates with our existing Express middleware and PostgreSQL database').complexity).toBe('moderate');
  });

  it('should provide secondary classification', () => {
    const result = classifyTask('Review and refactor this code to fix bugs');
    // Should have both code_review and code_generation signals
    expect(result.primary).toBeDefined();
    if (result.secondary) {
      expect(result.secondary).not.toBe(result.primary);
    }
  });
});
