import { z } from 'zod';

/**
 * Which STAR story elements an answer actually states. Each flag is set only when the
 * answer states the element outright, not when it merely hints at it — the assessment
 * is evidence for the director, so a hint is not a claim.
 */
export const starFlagsSchema = z.object({
  situation: z
    .boolean()
    .describe('The answer sets the scene: the team, company, or context the story happens in.'),
  task: z
    .boolean()
    .describe('The answer names a concrete problem or goal the candidate had to address.'),
  action: z.boolean().describe('The answer describes what the candidate actually did.'),
  result: z.boolean().describe('The answer states an outcome: how things ended up.'),
  quantifiedResult: z
    .boolean()
    .describe('The stated outcome carries a number or other measurable change.'),
});

export type StarFlags = z.infer<typeof starFlagsSchema>;

/**
 * The assessor's read of the latest answer: which STAR elements it states, whether the
 * current topic now holds enough signal to move on, whether the thread has gone dry,
 * and the claims worth chasing. The director consumes these to decide the next move.
 * `threadDry` is the second exit from a topic: sufficiency says the topic gave what it
 * had, dryness says it is giving nothing more — a terse candidate never triggers the
 * first, so without the second every thin topic gets probed until a cap ends it.
 */
export const answerAssessmentSchema = z.object({
  star: starFlagsSchema.describe('Which story elements the latest answer states, as evidence.'),
  sufficientSignal: z
    .boolean()
    .describe(
      'True when the conversation on the current topic now holds enough concrete evidence ' +
        'of how the candidate works that more questions on it would add little.',
    ),
  threadDry: z
    .boolean()
    .default(false)
    .describe(
      'True when the run of answers on the current topic is thinning - each shorter, ' +
        'terser, or pointing back at earlier answers - so another question on it would ' +
        'only get a thinner reply. A trend across answers, never a single short one: ' +
        'always false on the first answer of a topic.',
    ),
  claimsWorthChasing: z
    .array(z.string())
    .default([])
    .describe(
      'Claims from the latest answer worth a follow-up, quoted near-verbatim and ordered ' +
        'most interesting first. Empty when nothing stands out.',
    ),
});

export type AnswerAssessment = z.infer<typeof answerAssessmentSchema>;

/**
 * An answer assessment paired with the topic it was made on. The interview loop appends
 * one of these after every answered turn, building the assessment log the director reads.
 */
export const topicAssessmentSchema = z.object({
  topic: z.string().describe('The topic of conversation the assessed answer was on.'),
  assessment: answerAssessmentSchema,
});

export type TopicAssessment = z.infer<typeof topicAssessmentSchema>;
