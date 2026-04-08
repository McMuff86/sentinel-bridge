# Experimental Modules

These modules are architecturally sound but **not wired into the production code path**.
They are preserved here for future integration when a concrete use case emerges.

## KNN Router (`knn-router.ts`)

K-nearest-neighbor engine routing using text embeddings. Requires Ollama with
`nomic-embed-text` for embedding generation.

**What it does:** Embeds user queries, stores historical (query, engine, outcome)
records, and uses K-nearest-neighbor voting on successful past queries to
recommend the best engine for a new query.

**What's missing for integration:**

- `SessionManager` needs to call `addRecord()` after successful/failed sends
  (alongside the existing `adaptiveRouter.recordOutcome()`)
- `EmbeddingClient` must be initialized with Ollama URL during startup
- `AdaptiveRouter.setKnnRouter()` must be called to enable KNN/ensemble strategies
- Barrel exports in `index.ts` need to be restored

## Embedding Client (`embedding-client.ts`)

Ollama `/api/embed` client + `cosineSimilarity()` utility. Used by `KnnRouter`.

## Tests

`knn-router.test.ts` covers the KNN router logic with mocked embeddings.
