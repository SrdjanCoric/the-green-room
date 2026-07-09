import { createVectorQueryTool } from '@mastra/rag';

import { KNOWLEDGE_INDEX_NAME, KNOWLEDGE_VECTOR_STORE_NAME } from '../knowledge/config';
import { getEmbeddingModel } from '../knowledge/embedding';

/** Key the retrieval tool is registered under on the coach agent. */
export const COACH_RETRIEVAL_TOOL_KEY = 'retrieveGuidance';

/**
 * The request-context key `createVectorQueryTool` reads its embedding model from at
 * execute time (its documented runtime override). The coach step sets it per run, so
 * the model used to embed a query is supplied through the documented channel rather
 * than hardcoded on the tool.
 */
export const RETRIEVAL_MODEL_CONTEXT_KEY = 'model';

/**
 * The coach's retrieval tool. It queries the `how-to-answer` vector index so the
 * coach can ground each per-answer fix in the answer-craft methodology rather than
 * inventing generic tips. The store is resolved by name from the Mastra instance
 * (see `KNOWLEDGE_VECTOR_STORE_NAME`), and the query is embedded with the same model
 * that ingested the corpus, so both sides of the index share a vector space.
 *
 * The embedding model is supplied per run through the documented request-context
 * override ({@link RETRIEVAL_MODEL_CONTEXT_KEY}), which `createVectorQueryTool` reads
 * before this configured `model` — see the coach step. The configured `model` here is
 * a lazy fallback for a direct/Studio invocation that sets no override; it is a getter
 * because constructing the real model validates `OPENAI_API_KEY`, while this tool is
 * imported by the Anthropic-only interview flow (and the whole test suite), so the key
 * is needed only if the fallback is ever actually reached. This relies on
 * `createVectorQueryTool` reading `.model` at execute time, not at construction;
 * `coach-retrieval-import.test.ts` guards that contract so a `@mastra/rag` bump which read
 * `.model` eagerly — reinstating an import-time key check — is caught.
 */
export const coachRetrievalTool = createVectorQueryTool({
  id: 'retrieve-answer-guidance',
  description:
    'Retrieve answer-craft guidance from the how-to-answer corpus. Query it with the ' +
    'specific weakness in an answer — for example "result not quantified" or "ownership ' +
    'blurred into we" — to ground each fix in the methodology before writing it.',
  vectorStoreName: KNOWLEDGE_VECTOR_STORE_NAME,
  indexName: KNOWLEDGE_INDEX_NAME,
  get model() {
    return getEmbeddingModel();
  },
});
