import { Memory } from '@mastra/memory';

import { candidateWorkingMemorySchema } from './interview/coaching-ledger';
import { storage } from './storage';

/**
 * The interview's memory. Working memory is the {@link candidateWorkingMemorySchema}
 * shape — the parsed candidate profile plus a capped, code-computed ledger of past
 * coached sessions — scoped to the resource (the candidate) so both persist across
 * threads for the same person; the thread is one interview session.
 *
 * - `scope: 'resource'` keys the record on the candidate, not the session.
 * - `agentManaged: false` because the ingest step writes the profile and the coach
 *   step writes the ledger deterministically from validated structured outputs,
 *   rather than letting a model update working memory through tool calls. Growth is
 *   bounded by construction: fixed-shape entries, capped at ten, upserted by run id.
 * - No semantic recall and no observational memory: nothing here records
 *   conversation messages for an observer to extract from (single-shot generates,
 *   structured outputs), and grading requires verbatim answers. Observational
 *   memory is evaluated-and-deferred — the revisit trigger is a future
 *   conversational coach-chat surface, whose message threads would be exactly what
 *   it is built for.
 */
export const candidateMemory = new Memory({
  storage,
  options: {
    workingMemory: {
      enabled: true,
      scope: 'resource',
      // Documents the working-memory shape and future-proofs an eventual agent
      // attachment, but is NOT the runtime guarantee here: `@mastra/memory` only
      // `safeParse`s against this schema on the agent / observational-extractor
      // write paths, which this app does not use. Our writes go through
      // `updateWorkingMemory` directly, which does not consult it. The authoritative
      // validation is in-code Zod parsing — `candidateProfileSchema.parse` in ingest
      // and `candidateWorkingMemorySchema.safeParse` in `parseCandidateWorkingMemory`.
      schema: candidateWorkingMemorySchema,
      agentManaged: false,
    },
    semanticRecall: false,
    generateTitle: false,
    // Working memory only: no agent runs with thread history flowing, so a positive
    // `lastMessages` would imply a recorded conversation that does not exist. `false`
    // disables history injection outright and says so.
    lastMessages: false,
  },
});
