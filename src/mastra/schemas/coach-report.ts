import { z } from 'zod';

import { starFlagsSchema } from './answer-assessment';

// The candidate-facing coach report (summary, per-answer advice, drills, study plan)
// is part of the client/server wire contract, so it is defined in the dependency-free
// `shared/wire-contract` module the web client also imports and re-exported here. The
// grading schemas below (answer scores, session grade) stay local — they never cross
// the wire and depend on the assessment schemas.
export {
  answerAdviceSchema,
  drillSchema,
  coachReportSchema,
} from '../../../shared/wire-contract';
export type { AnswerAdvice, Drill, CoachReport } from '../../../shared/wire-contract';

export const answerScoreSchema = z
  .object({
    question: z.string().describe('The interview question this score grades.'),
    turnIndex: z.number().int().nonnegative().describe('Zero-based transcript turn index.'),
    rationale: z.string().min(1).describe('Evidence-backed reason for the score.'),
    star: starFlagsSchema.describe('Which STAR elements the answer stated.'),
    specificity: z.string().min(1).describe('How concrete and example-specific the answer was.'),
    ownership: z.string().min(1).describe('How clearly the answer names the candidate-owned work.'),
    weakOrMissing: z
      .array(z.string().min(1))
      .default([])
      .describe('Concrete answer elements that were weak, missing, or unsupported.'),
    gap: z
      .string()
      .describe('The main gap to fix; empty only when the answer earns a perfect score.'),
    score: z.number().int().min(1).max(5).describe('Overall answer score from 1 to 5.'),
  })
  .superRefine((score, context) => {
    const hasGap = score.gap.trim().length > 0;
    if (score.score < 5 && !hasGap) {
      context.addIssue({
        code: 'custom',
        path: ['gap'],
        message: 'gap must be non-empty when score is below 5',
      });
    }
    if (score.score === 5 && hasGap) {
      context.addIssue({
        code: 'custom',
        path: ['gap'],
        message: 'gap must be empty when score is 5',
      });
    }
    if (score.score === 5 && score.weakOrMissing.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['weakOrMissing'],
        message: 'weakOrMissing must be empty when score is 5',
      });
    }
  });

export type AnswerScore = z.infer<typeof answerScoreSchema>;

export const skippedTurnSchema = z.object({
  turnIndex: z.number().int().nonnegative().describe('Zero-based transcript turn index.'),
  question: z.string().describe('The interview question for this skipped turn.'),
  reason: z.string().min(1).describe('Why this turn was not answer-gradeable.'),
});

export type SkippedTurn = z.infer<typeof skippedTurnSchema>;

export const sessionGradeSchema = z.object({
  scores: z.array(answerScoreSchema),
  skipped: z
    .array(skippedTurnSchema)
    .default([])
    .describe('Why any non-answer material was skipped; transcript turns must still be covered.'),
});

export type SessionGrade = z.infer<typeof sessionGradeSchema>;

export function sessionGradeForTranscriptSchema(turnCount: number) {
  return sessionGradeSchema.superRefine((grade, context) => {
    const seen = new Set<number>();
    const coveredTurns = [
      ...grade.scores.map((entry) => ({ turnIndex: entry.turnIndex, kind: 'score' })),
      ...grade.skipped.map((entry) => ({ turnIndex: entry.turnIndex, kind: 'skip' })),
    ];

    for (const entry of coveredTurns) {
      if (entry.turnIndex < 0 || entry.turnIndex >= turnCount) {
        context.addIssue({
          code: 'custom',
          path: ['scores'],
          message: `turnIndex ${entry.turnIndex} is outside transcript range 0-${turnCount - 1}`,
        });
      }
      if (seen.has(entry.turnIndex)) {
        context.addIssue({
          code: 'custom',
          path: ['scores'],
          message: `turnIndex ${entry.turnIndex} is covered more than once`,
        });
      }
      seen.add(entry.turnIndex);
    }

    if (seen.size !== turnCount) {
      context.addIssue({
        code: 'custom',
        path: ['scores'],
        message: `grade must cover all ${turnCount} transcript turns exactly once`,
      });
    }
  });
}
