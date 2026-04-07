import type { EngineKind } from '../types.js';
import { cosineSimilarity } from './embedding-client.js';
import type { EmbeddingClient } from './embedding-client.js';

export interface EmbeddingRecord {
  query: string;
  embedding: number[];
  engine: EngineKind;
  category: string;
  outcome: 'success' | 'failure';
  timestamp: string;
}

export interface KnnRoutingResult {
  engine: EngineKind;
  confidence: number;
  neighbors: number;
}

const MAX_RECORDS = 10000;

/**
 * KNN-based engine router.
 *
 * Embeds user queries via Ollama, stores historical (query, engine, outcome)
 * records, and uses K-nearest-neighbor voting on successful past queries
 * to recommend the best engine for a new query.
 */
export class KnnRouter {
  private records: EmbeddingRecord[] = [];
  private readonly client: EmbeddingClient;
  private _available = false;

  constructor(client: EmbeddingClient) {
    this.client = client;
  }

  async checkAvailability(): Promise<boolean> {
    this._available = await this.client.isAvailable();
    return this._available;
  }

  get available(): boolean { return this._available; }

  async addRecord(
    query: string,
    engine: EngineKind,
    category: string,
    outcome: 'success' | 'failure',
  ): Promise<void> {
    if (!this._available) return;
    try {
      const result = await this.client.embed(query);
      this.records.push({
        query,
        embedding: result.embedding,
        engine,
        category,
        outcome,
        timestamp: new Date().toISOString(),
      });
      // Prune oldest if over limit
      if (this.records.length > MAX_RECORDS) {
        this.records = this.records.slice(this.records.length - MAX_RECORDS);
      }
    } catch {
      // Graceful degradation — skip embedding if Ollama fails
    }
  }

  async selectEngine(
    query: string,
    available: EngineKind[],
    k = 5,
  ): Promise<KnnRoutingResult | null> {
    if (!this._available || this.records.length < k) return null;

    let queryEmbedding: number[];
    try {
      const result = await this.client.embed(query);
      queryEmbedding = result.embedding;
    } catch {
      return null;
    }

    // Find K nearest successful neighbors from available engines
    const successRecords = this.records.filter(
      r => r.outcome === 'success' && available.includes(r.engine),
    );
    if (successRecords.length < k) return null;

    const scored = successRecords.map(record => ({
      record,
      similarity: cosineSimilarity(queryEmbedding, record.embedding),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    const neighbors = scored.slice(0, k);

    // Vote: count engines among neighbors, weighted by similarity
    const votes = new Map<EngineKind, { count: number; totalSim: number }>();
    for (const { record, similarity } of neighbors) {
      const v = votes.get(record.engine) ?? { count: 0, totalSim: 0 };
      v.count += 1;
      v.totalSim += similarity;
      votes.set(record.engine, v);
    }

    // Pick engine with most votes (slight similarity bonus)
    let bestEngine: EngineKind | null = null;
    let bestScore = -1;
    for (const [engine, { count, totalSim }] of votes) {
      const score = count + totalSim * 0.1;
      if (score > bestScore) {
        bestScore = score;
        bestEngine = engine;
      }
    }

    if (!bestEngine) return null;

    const bestVote = votes.get(bestEngine)!;
    return {
      engine: bestEngine,
      confidence: bestVote.count / k,
      neighbors: k,
    };
  }

  exportRecords(): EmbeddingRecord[] {
    return [...this.records];
  }

  importRecords(records: EmbeddingRecord[]): void {
    this.records = records.slice(-MAX_RECORDS);
  }

  get recordCount(): number { return this.records.length; }
}
