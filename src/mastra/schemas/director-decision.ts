import { z } from 'zod';

/**
 * The five moves the director can make each turn. `follow_up` digs into the last
 * answer, `reprompt` re-asks a fair question the candidate deflected, `new_topic`
 * opens a different stretch of the interview, `wrap_up` ends the session because it
 * holds enough signal, and `terminate` ends it because the input has stopped being an
 * interview.
 */
export const DIRECTOR_ACTIONS = [
  'follow_up',
  'reprompt',
  'new_topic',
  'wrap_up',
  'terminate',
] as const;

export const directorActionSchema = z.enum(DIRECTOR_ACTIONS);

export type DirectorAction = z.infer<typeof directorActionSchema>;

/**
 * The director's decision on what the interview should do next. The interviewer turns a
 * `follow_up`, `reprompt`, or `new_topic` into the actual question; `wrap_up` and
 * `terminate` end the loop and carry no subject. The reason is internal — it is never
 * shown to the candidate.
 */
export const directorDecisionSchema = z.object({
  action: directorActionSchema.describe(
    'What happens next: follow_up digs into the last answer, reprompt re-asks a fair ' +
      'question the candidate deflected or wrongly claimed they already answered, ' +
      'new_topic opens a different stretch of the interview, wrap_up ends the session ' +
      'because there is enough signal, terminate ends it because the input has stopped ' +
      'being an interview.',
  ),
  subject: z
    .string()
    .default('')
    .describe(
      'For follow_up: the claim or aspect of the last answer to chase, near-verbatim. ' +
        'For reprompt: the substance of the unanswered question to put to them again. ' +
        'For new_topic: the topic to open, concrete enough that a colleague could ask ' +
        'about it. Empty for wrap_up and terminate.',
    ),
  reason: z
    .string()
    .default('')
    .describe('Why this is the right move now, in one sentence. Never shown to the candidate.'),
});

export type DirectorDecision = z.infer<typeof directorDecisionSchema>;
