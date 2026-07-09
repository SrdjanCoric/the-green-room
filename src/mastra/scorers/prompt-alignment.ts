import type { MastraModelConfig } from '@mastra/core/llm';
import { createPromptAlignmentScorerLLM } from '@mastra/evals/scorers/prebuilt';

/** The id the prebuilt prompt-alignment scorer stores under (Studio + `mastra_scorers`). */
export const PROMPT_ALIGNMENT_SCORER_ID = 'prompt-alignment-scorer';

/**
 * The live monitoring scorer for the model-facing agents. Prompt-alignment is an LLM
 * judge that rates how well an agent's response served the request it was given and the
 * instructions it runs under — for the interviewer, whether the question it asked serves
 * the director's decision in the house voice; for the grader, whether the grade addresses
 * the transcript against the rubric it was told to apply. `evaluationMode: 'both'` scores
 * intent, requirements, completeness, and appropriateness across the user turn and the
 * system prompt.
 *
 * It is monitoring only: sampled in the background, never gating or rewriting the response
 * the candidate sees. It needs no ground-truth labels, which is what a live production
 * signal requires — reference labels only exist in the offline eval dataset. The judge
 * model is passed in rather than hardcoded, so it follows the run's provider and tier.
 */
export function createPromptAlignmentScorer(model: MastraModelConfig) {
  return createPromptAlignmentScorerLLM({ model, options: { evaluationMode: 'both' } });
}
