import { z } from 'zod';

/**
 * One recorded exchange of the interview: the question posed and the candidate's
 * verbatim answer. Answers are kept word-for-word — grading (task 0007) scores the
 * exact text, so nothing here is summarized.
 */
export const transcriptEntrySchema = z.object({
  question: z.string().describe('The question the interviewer asked this turn.'),
  answer: z.string().describe("The candidate's answer, verbatim."),
});

export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;
