import { z } from 'zod';

import { starFlagsSchema } from './answer-assessment';

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

export const answerAdviceSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe('The interview question this advice is about, quoted near-verbatim.'),
  diagnosis: z
    .string()
    .min(1)
    .describe(
      'What specifically held this answer back, named against what the candidate actually said, not in the abstract.',
    ),
  fix: z
    .string()
    .min(1)
    .describe(
      "The concrete thing to do differently next time, tied to this answer's own gap: what to add, name, or quantify. Never generic advice like \"be more specific\".",
    ),
});

export type AnswerAdvice = z.infer<typeof answerAdviceSchema>;

export const drillSchema = z.object({
  focus: z.string().min(1).describe('The recurring weakness this drill builds, named in plain words.'),
  exercise: z
    .string()
    .min(1)
    .describe('A concrete practice exercise the candidate can run on their own to build it.'),
});

export type Drill = z.infer<typeof drillSchema>;

export const coachReportSchema = z.object({
  summary: z
    .string()
    .describe(
      'A candid read of how the session went across the answers: what is already working and what most needs work.',
    ),
  answerAdvice: z
    .array(answerAdviceSchema)
    .default([])
    .describe('One entry per answer that needs work, in transcript order. Strong answers are left out.'),
  drills: z
    .array(drillSchema)
    .default([])
    .describe('A drill per recurring weak area the session surfaced. Empty when nothing recurs.'),
  studyPlan: z
    .string()
    .describe('A short plan aggregating the weak areas into what to work on, in priority order.'),
});

export type CoachReport = z.infer<typeof coachReportSchema>;
