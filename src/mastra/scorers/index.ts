import type { MastraScorers } from '@mastra/core/evals';
import type { RequestContext } from '@mastra/core/request-context';

import { getTierModel, resolveModelTiers } from '../model-config';
import {
  GRADER_AGREEMENT_SCORER_ID,
  graderAgreementScorer,
} from './grader-agreement';
import { PROMPT_ALIGNMENT_SCORER_ID, createPromptAlignmentScorer } from './prompt-alignment';

/**
 * Monitoring scorers, in two shapes for two jobs:
 *
 * - **Live monitoring** — a sampled prompt-alignment LLM judge attached to the interviewer
 *   and the grader. It runs in the background on real runs and its scores (value + reason)
 *   surface in Studio, without a ground-truth label and without ever touching the response
 *   a candidate sees. This is the only kind of signal available live, where there are no
 *   reference labels to check against.
 * - **Regression eval** — the deterministic {@link graderAgreementScorer}, run via
 *   `runEvals` over a committed labeled dataset. It checks the grader against human labels
 *   (floor/ceiling/skips/dodges) — a meaningful, model-free signal that a live scorer can't
 *   give because production has no labels.
 *
 * The user-facing grade stays the workflow's grade step; nothing here gates or rewrites it.
 */

/** Record key both agents attach their prompt-alignment monitor under. */
export const PROMPT_ALIGNMENT_KEY = 'promptAlignment';

/** The LLM judge costs tokens, so it scores a fraction of runs — visibility against cost. */
export const PROMPT_ALIGNMENT_SAMPLING = { type: 'ratio', rate: 0.5 } as const;

/**
 * Build an agent's sampled prompt-alignment monitor, resolved per run so the judge follows
 * the run's smart-tier model (a monitoring judge wants the more capable tier; sampling
 * keeps the cost bounded). Used as both agents' `scorers` resolver.
 */
export function buildPromptAlignmentScorers({
  requestContext,
}: {
  requestContext: RequestContext;
}): MastraScorers {
  return {
    [PROMPT_ALIGNMENT_KEY]: {
      scorer: createPromptAlignmentScorer(getTierModel(requestContext, 'smart')),
      sampling: PROMPT_ALIGNMENT_SAMPLING,
    },
  };
}

/**
 * The scorer catalog registered on the Mastra instance, keyed by scorer id, so Studio lists
 * them and `runEvals` can reach them by name: the live prompt-alignment judge (built with
 * the default smart-tier model; the agent-attached copies follow the live run's tier and
 * share this id) and the grader-agreement eval scorer.
 */
export const monitoringScorers = {
  [PROMPT_ALIGNMENT_SCORER_ID]: createPromptAlignmentScorer(resolveModelTiers().smart),
  [GRADER_AGREEMENT_SCORER_ID]: graderAgreementScorer,
};

export {
  GRADER_AGREEMENT_SCORER_ID,
  graderAgreementScorer,
  evaluateTranscriptAgreement,
  transcriptExpectationSchema,
  type TranscriptExpectation,
} from './grader-agreement';
export { PROMPT_ALIGNMENT_SCORER_ID, createPromptAlignmentScorer } from './prompt-alignment';
