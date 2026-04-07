import { describe, it, expect, vi } from 'vitest';
import { KnnRouter } from '../orchestration/knn-router.js';
import { cosineSimilarity, EmbeddingClient } from '../orchestration/embedding-client.js';
import type { EmbeddingRecord } from '../orchestration/knn-router.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
  });

  it('handles normalized vectors correctly', () => {
    const a = [1 / Math.sqrt(2), 1 / Math.sqrt(2)];
    const b = [1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1 / Math.sqrt(2));
  });
});

describe('KnnRouter', () => {
  function createMockClient(embeddings: Map<string, number[]>): EmbeddingClient {
    return {
      embed: vi.fn().mockImplementation(async (text: string) => {
        const embedding = embeddings.get(text) ?? [0.5, 0.5, 0.5];
        return { embedding, model: 'mock' };
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as EmbeddingClient;
  }

  it('returns null when not enough records', async () => {
    const client = createMockClient(new Map());
    const router = new KnnRouter(client);
    await router.checkAvailability();
    const result = await router.selectEngine('test query', ['claude', 'codex'], 5);
    expect(result).toBeNull();
  });

  it('selects engine by KNN vote', async () => {
    // Create embeddings: claude queries near [1,0,0], codex queries near [0,1,0]
    const embeddings = new Map<string, number[]>();
    embeddings.set('new query', [0.9, 0.1, 0]);

    const client = createMockClient(embeddings);
    const router = new KnnRouter(client);
    await router.checkAvailability();

    // Pre-load records
    const records: EmbeddingRecord[] = [];
    for (let i = 0; i < 5; i++) {
      records.push({
        query: `claude task ${i}`,
        embedding: [1, 0.1 * i, 0],
        engine: 'claude',
        category: 'code_generation',
        outcome: 'success',
        timestamp: new Date().toISOString(),
      });
    }
    for (let i = 0; i < 5; i++) {
      records.push({
        query: `codex task ${i}`,
        embedding: [0, 1, 0.1 * i],
        engine: 'codex',
        category: 'code_generation',
        outcome: 'success',
        timestamp: new Date().toISOString(),
      });
    }
    router.importRecords(records);

    const result = await router.selectEngine('new query', ['claude', 'codex'], 5);
    expect(result).not.toBeNull();
    expect(result!.engine).toBe('claude'); // closer to [1,0,0] cluster
    expect(result!.confidence).toBeGreaterThan(0);
    expect(result!.neighbors).toBe(5);
  });

  it('only considers successful records from available engines', async () => {
    const embeddings = new Map<string, number[]>();
    embeddings.set('query', [1, 0, 0]);

    const client = createMockClient(embeddings);
    const router = new KnnRouter(client);
    await router.checkAvailability();

    const records: EmbeddingRecord[] = [];
    // Claude: all failures
    for (let i = 0; i < 5; i++) {
      records.push({
        query: `claude ${i}`,
        embedding: [1, 0, 0],
        engine: 'claude',
        category: 'general',
        outcome: 'failure',
        timestamp: new Date().toISOString(),
      });
    }
    // Codex: all successes but far away
    for (let i = 0; i < 5; i++) {
      records.push({
        query: `codex ${i}`,
        embedding: [0, 1, 0],
        engine: 'codex',
        category: 'general',
        outcome: 'success',
        timestamp: new Date().toISOString(),
      });
    }
    router.importRecords(records);

    const result = await router.selectEngine('query', ['claude', 'codex'], 5);
    // Only codex has successful records
    expect(result).not.toBeNull();
    expect(result!.engine).toBe('codex');
  });

  it('respects available engine filter', async () => {
    const embeddings = new Map<string, number[]>();
    embeddings.set('query', [1, 0, 0]);

    const client = createMockClient(embeddings);
    const router = new KnnRouter(client);
    await router.checkAvailability();

    const records: EmbeddingRecord[] = [];
    // Claude: successes near query
    for (let i = 0; i < 5; i++) {
      records.push({
        query: `claude ${i}`,
        embedding: [1, 0.05 * i, 0],
        engine: 'claude',
        category: 'general',
        outcome: 'success',
        timestamp: new Date().toISOString(),
      });
    }
    // Codex: successes far away
    for (let i = 0; i < 5; i++) {
      records.push({
        query: `codex ${i}`,
        embedding: [0, 1, 0],
        engine: 'codex',
        category: 'general',
        outcome: 'success',
        timestamp: new Date().toISOString(),
      });
    }
    router.importRecords(records);

    // Only codex available — claude filtered out
    const result = await router.selectEngine('query', ['codex'], 5);
    expect(result).not.toBeNull();
    expect(result!.engine).toBe('codex');
  });

  it('returns null when embed fails', async () => {
    const client = {
      embed: vi.fn().mockRejectedValue(new Error('Ollama down')),
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as EmbeddingClient;

    const router = new KnnRouter(client);
    await router.checkAvailability();

    // Import enough records to pass the k check
    const records: EmbeddingRecord[] = [];
    for (let i = 0; i < 5; i++) {
      records.push({
        query: `task ${i}`,
        embedding: [1, 0, 0],
        engine: 'claude',
        category: 'general',
        outcome: 'success',
        timestamp: new Date().toISOString(),
      });
    }
    router.importRecords(records);

    const result = await router.selectEngine('query', ['claude'], 5);
    expect(result).toBeNull();
  });

  it('export/import roundtrips records', () => {
    const client = createMockClient(new Map());
    const router = new KnnRouter(client);
    const records: EmbeddingRecord[] = [
      {
        query: 'test',
        embedding: [1, 2],
        engine: 'claude',
        category: 'general',
        outcome: 'success',
        timestamp: '2026-01-01T00:00:00Z',
      },
    ];
    router.importRecords(records);
    expect(router.exportRecords()).toHaveLength(1);
    expect(router.recordCount).toBe(1);
  });

  it('gracefully handles unavailable state', async () => {
    const client = {
      embed: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(false),
    } as unknown as EmbeddingClient;

    const router = new KnnRouter(client);
    await router.checkAvailability();
    expect(router.available).toBe(false);

    // addRecord should silently skip
    await router.addRecord('query', 'claude', 'general', 'success');
    expect(router.recordCount).toBe(0);
  });

  it('addRecord embeds and stores when available', async () => {
    const embeddings = new Map<string, number[]>();
    embeddings.set('hello world', [0.1, 0.2, 0.3]);

    const client = createMockClient(embeddings);
    const router = new KnnRouter(client);
    await router.checkAvailability();

    await router.addRecord('hello world', 'claude', 'general', 'success');
    expect(router.recordCount).toBe(1);

    const exported = router.exportRecords();
    expect(exported[0]!.query).toBe('hello world');
    expect(exported[0]!.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(exported[0]!.engine).toBe('claude');
    expect(exported[0]!.outcome).toBe('success');
  });

  it('addRecord gracefully handles embed failure', async () => {
    const client = {
      embed: vi.fn().mockRejectedValue(new Error('fail')),
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as EmbeddingClient;

    const router = new KnnRouter(client);
    await router.checkAvailability();

    // Should not throw
    await router.addRecord('query', 'claude', 'general', 'success');
    expect(router.recordCount).toBe(0);
  });
});
