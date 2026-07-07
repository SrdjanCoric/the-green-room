import { createVectorQueryTool } from '@mastra/rag';

import { KNOWLEDGE_INDEX_NAME, KNOWLEDGE_VECTOR_STORE_NAME } from '../knowledge/config';
import { getEmbeddingModel } from '../knowledge/embedding';

/** Key the retrieval tool is registered under on the coach agent. */
export const COACH_RETRIEVAL_TOOL_KEY = 'retrieveGuidance';

/**
 * The coach's retrieval tool. It queries the `how-to-answer` vector index so the
 * coach can ground each per-answer fix in the answer-craft methodology rather than
 * inventing generic tips. The store is resolved by name from the Mastra instance
 * (see `KNOWLEDGE_VECTOR_STORE_NAME`), and the query is embedded with the same model
 * that ingested the corpus, so both sides of the index share a vector space.
 *
 * The embedding model is supplied through a getter because it validates
 * `OPENAI_API_KEY` at construction, while this tool is imported by the
 * Anthropic-only interview flow (and the whole test suite). `createVectorQueryTool`
 * reads `model` only inside the tool's execute path, so the key is needed only when
 * the coach actually retrieves — not merely to construct the agent.
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
