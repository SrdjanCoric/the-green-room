import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';

import { KNOWLEDGE_INDEX_NAME, KNOWLEDGE_VECTOR_STORE_NAME } from '../knowledge/config';
import { COACH_RETRIEVAL_TOOL_KEY, coachRetrievalTool } from './coach-retrieval';

type ExecuteInput = Parameters<NonNullable<typeof coachRetrievalTool.execute>>[0];
type ExecuteContext = Parameters<NonNullable<typeof coachRetrievalTool.execute>>[1];

/**
 * A fake v2 embedding model injected through the request context (the tool reads
 * `requestContext.get('model')` before its configured model), so the execute path
 * runs without an OpenAI key or network.
 */
function fakeEmbedder(vector: number[]) {
  const embedded: string[] = [];
  return {
    embedded,
    model: {
      specificationVersion: 'v2' as const,
      provider: 'test',
      modelId: 'test-embedder',
      maxEmbeddingsPerCall: 1,
      supportsParallelCalls: false,
      doEmbed: async ({ values }: { values: string[] }) => {
        embedded.push(...values);
        return { embeddings: values.map(() => vector), usage: { tokens: 1 } };
      },
    },
  };
}

/** A fake vector store that records each query and answers with canned chunks. */
function fakeVectorStore(chunks: { text: string }[]) {
  const queries: { indexName: string; queryVector: number[]; topK: number }[] = [];
  return {
    queries,
    store: {
      query: async (params: { indexName: string; queryVector: number[]; topK: number }) => {
        queries.push(params);
        return chunks.map((metadata, index) => ({
          id: `chunk-${index}`,
          score: 1 - index * 0.1,
          metadata,
        }));
      },
    },
  };
}

describe('coachRetrievalTool execute path', () => {
  it('embeds the weakness query and retrieves chunks from the how-to-answer index', async () => {
    const { model, embedded } = fakeEmbedder([0.1, 0.2, 0.3]);
    const { store, queries } = fakeVectorStore([
      { text: 'End the answer with the number you moved.' },
      { text: 'Name what you did, not what the team did.' },
    ]);
    const storeNames: string[] = [];

    const requestContext = new RequestContext();
    requestContext.set('model', model);
    const context = {
      requestContext,
      mastra: {
        getVector: (name: string) => {
          storeNames.push(name);
          return store;
        },
        getLogger: () => undefined,
      },
    } as unknown as ExecuteContext;

    if (!coachRetrievalTool.execute) throw new Error('expected the tool to be executable');
    const input: ExecuteInput = { queryText: 'result not quantified', topK: 2 };
    const result = (await coachRetrievalTool.execute(input, context)) as {
      relevantContext: { text: string }[];
      sources: unknown[];
    };

    // The query was embedded — not passed through as raw text — and the search hit
    // the configured store and index with the embedded vector.
    expect(embedded).toEqual(['result not quantified']);
    expect(storeNames).toEqual([KNOWLEDGE_VECTOR_STORE_NAME]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      indexName: KNOWLEDGE_INDEX_NAME,
      queryVector: [0.1, 0.2, 0.3],
      topK: 2,
    });

    // The stored chunk metadata comes back as the coach-facing relevant context.
    expect(result.relevantContext).toEqual([
      { text: 'End the answer with the number you moved.' },
      { text: 'Name what you did, not what the team did.' },
    ]);
    expect(result.sources).toHaveLength(2);
  });

  it('is the tool the coach registers under the retrieval key', () => {
    // Guards the id/key pair the agent test asserts against from the tool side.
    expect(COACH_RETRIEVAL_TOOL_KEY).toBe('retrieveGuidance');
    expect(coachRetrievalTool.id).toBe('retrieve-answer-guidance');
  });
});
