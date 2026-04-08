export interface EmbeddingResult {
  embedding: number[];
  model: string;
}

/**
 * Client for generating text embeddings via the Ollama /api/embed endpoint.
 * Uses nomic-embed-text by default — a fast, high-quality embedding model.
 */
export class EmbeddingClient {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(baseUrl = 'http://localhost:11434', model = 'nomic-embed-text') {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as { embeddings: number[][] };
    if (!data.embeddings || !data.embeddings[0]) {
      throw new Error('No embeddings returned from Ollama');
    }
    return { embedding: data.embeddings[0], model: this.model };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return false;
      const data = await response.json() as { models?: Array<{ name: string }> };
      return data.models?.some(m => m.name.startsWith(this.model)) ?? false;
    } catch {
      return false;
    }
  }
}

/**
 * Compute cosine similarity between two vectors.
 * Returns 0 for empty or mismatched-length vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
