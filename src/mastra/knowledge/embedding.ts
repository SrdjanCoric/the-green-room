import { ModelRouterEmbeddingModel } from '@mastra/core/llm';

import { EMBEDDING_MODEL } from './config';

/**
 * Turn a batch of texts into embedding vectors. Injecting this as a function keeps
 * ingestion and its tests decoupled from any particular embedding backend: the app
 * wires in the OpenAI model router, tests wire in a deterministic stand-in.
 */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/**
 * Deferred construction of the embedding model. `ModelRouterEmbeddingModel`
 * validates `OPENAI_API_KEY` in its constructor, but the coach agent — and through
 * it the whole Mastra instance and test suite — is imported by the Anthropic-only
 * interview flow, which must not require an OpenAI key. Only work that actually
 * embeds (an ingest run or a coach retrieval) needs the key, so the model is built
 * lazily on first use and memoised thereafter.
 */
let cachedModel: ModelRouterEmbeddingModel | undefined;
export function getEmbeddingModel(): ModelRouterEmbeddingModel {
  cachedModel ??= new ModelRouterEmbeddingModel(EMBEDDING_MODEL);
  return cachedModel;
}

/**
 * The production {@link Embedder}: embeds all texts through the OpenAI model router,
 * batching to the provider's per-call cap. This drives the model's `doEmbed` directly
 * rather than the AI SDK's `embedMany`: `embedMany` lives in the `ai` package, which
 * this project does not depend on (Mastra core re-exports only single-value `embed`),
 * so `doEmbed` is the batch primitive that keeps us on the same model the query side
 * uses without pulling in a second copy of the SDK. `maxEmbeddingsPerCall` is typed as
 * possibly a promise by the embedding interface, hence the `await`; the `> 0` guard
 * avoids a zero cap turning the loop into an infinite one.
 */
export function createRouterEmbedder(model: ModelRouterEmbeddingModel = getEmbeddingModel()): Embedder {
  return async (texts) => {
    if (texts.length === 0) return [];
    const cap = await model.maxEmbeddingsPerCall;
    const batchSize = cap && cap > 0 ? cap : texts.length;
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize);
      const { embeddings } = await model.doEmbed({ values: batch });
      vectors.push(...embeddings);
    }
    return vectors;
  };
}
