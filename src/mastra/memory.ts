import { Memory } from '@mastra/memory';

import { candidateProfileSchema } from './schemas/candidate-profile';
import { storage } from './storage';

/**
 * The interview's memory. Working memory is the {@link candidateProfileSchema}
 * shape, scoped to the resource (the candidate) so a profile persists across
 * threads for the same person; the thread is one interview session.
 *
 * - `scope: 'resource'` keys the profile on the candidate, not the session.
 * - `agentManaged: false` because the ingest step writes the profile
 *   deterministically from the parser's structured output rather than letting the
 *   model update working memory through tool calls.
 * - No semantic recall and no observational memory: a single short session needs
 *   neither, and grading later requires verbatim answers, so nothing here is
 *   summarised away. Conversation history is bounded to the recent turns.
 */
export const candidateMemory = new Memory({
  storage,
  options: {
    workingMemory: {
      enabled: true,
      scope: 'resource',
      schema: candidateProfileSchema,
      agentManaged: false,
    },
    semanticRecall: false,
    generateTitle: false,
    lastMessages: 20,
  },
});
