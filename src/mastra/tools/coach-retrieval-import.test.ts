import { describe, expect, it, vi } from 'vitest';

/**
 * The coach retrieval tool passes a lazy `get model()` getter to `createVectorQueryTool`
 * (see `coach-retrieval.ts`): the real embedding model validates `OPENAI_API_KEY` in its
 * constructor, and this tool is imported by the Anthropic-only interview flow (and the
 * whole test suite), so the embedder must only be built if the fallback is actually
 * reached at execute time — never at import.
 *
 * That safety relies on `@mastra/rag` reading `.model` lazily (at execute time), not at
 * construction. This test pins that contract: it mocks `getEmbeddingModel` and asserts
 * importing the tool never calls it. A future `@mastra/rag` bump that eagerly read
 * `.model` when the tool is built would call the mock and fail here — catching an
 * import-time `OPENAI_API_KEY` check in the Anthropic-only flow before it ships.
 */
const { getEmbeddingModel } = vi.hoisted(() => ({
  getEmbeddingModel: vi.fn(() => {
    throw new Error('getEmbeddingModel must not be called at import time');
  }),
}));

vi.mock('../knowledge/embedding', () => ({ getEmbeddingModel }));

describe('coach retrieval tool import', () => {
  it('does not construct the embedding model when the module is imported', async () => {
    const mod = await import('./coach-retrieval');

    // Building the tool (which happens at import) must not read `.model`, so the mocked
    // embedder factory is never invoked.
    expect(getEmbeddingModel).not.toHaveBeenCalled();
    expect(mod.coachRetrievalTool).toBeDefined();
  });
});
