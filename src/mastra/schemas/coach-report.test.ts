import { describe, expect, it } from 'vitest';

import {
  answerScoreSchema,
  coachReportSchema,
  sessionGradeForTranscriptSchema,
} from './coach-report';

const completeStar = {
  situation: true,
  task: true,
  action: true,
  result: true,
  quantifiedResult: true,
};

function score(overrides: Record<string, unknown> = {}) {
  return {
    question: 'Tell me about a technical decision.',
    turnIndex: 0,
    rationale: 'The answer gives context, action, and a measurable result.',
    star: completeStar,
    specificity: 'Names the system and the decision.',
    ownership: 'Clearly separates candidate work from team work.',
    weakOrMissing: [],
    gap: '',
    score: 5,
    ...overrides,
  };
}

describe('answerScoreSchema', () => {
  it('accepts a perfect score only when the gap is empty', () => {
    expect(answerScoreSchema.parse(score()).gap).toBe('');

    const result = answerScoreSchema.safeParse(score({ gap: 'Needs a stronger result.' }));
    expect(result.success).toBe(false);
  });

  it('rejects a perfect score with weak-or-missing notes', () => {
    const result = answerScoreSchema.safeParse(score({ weakOrMissing: ['No quantified result'] }));

    expect(result.success).toBe(false);
  });

  it('requires a non-empty gap for any score below five', () => {
    const parsed = answerScoreSchema.parse(
      score({ score: 3, gap: 'The answer never names the candidate-owned decision.' }),
    );

    expect(parsed.gap).toContain('decision');
    expect(answerScoreSchema.safeParse(score({ score: 4, gap: '  ' })).success).toBe(false);
  });
});

describe('sessionGradeForTranscriptSchema', () => {
  const schema = sessionGradeForTranscriptSchema(2);

  it('requires every transcript turn to be graded exactly once', () => {
    const parsed = schema.parse({
      scores: [score({ turnIndex: 0 }), score({ turnIndex: 1, score: 4, gap: 'Add outcome.' })],
      skipped: [],
    });

    expect(parsed.scores.map((entry) => entry.turnIndex)).toEqual([0, 1]);
  });

  it('allows a turn to be covered by a scored answer or a skipped turn', () => {
    const parsed = schema.parse({
      scores: [score({ turnIndex: 0 })],
      skipped: [
        {
          turnIndex: 1,
          question: 'Was that at Acme?',
          reason: 'Clarifying confirmation with no answer substance to grade.',
        },
      ],
    });

    expect(parsed.skipped[0]!.turnIndex).toBe(1);
  });

  it('rejects missing, duplicate, and out-of-range turn coverage', () => {
    expect(schema.safeParse({ scores: [score({ turnIndex: 0 })], skipped: [] }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        scores: [score({ turnIndex: 0 }), score({ turnIndex: 0, score: 4, gap: 'Add result.' })],
        skipped: [],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        scores: [score({ turnIndex: 0 }), score({ turnIndex: 2, score: 4, gap: 'Add result.' })],
        skipped: [],
      }).success,
    ).toBe(false);
  });
});

describe('coachReportSchema', () => {
  it('accepts a structured coaching report keyed by question', () => {
    const parsed = coachReportSchema.parse({
      summary: 'Clear ownership, but outcomes need numbers.',
      answerAdvice: [
        {
          question: 'Tell me about a technical decision.',
          diagnosis: 'The action is clear, but the result is vague.',
          fix: 'End on the number you moved: "I cut deploy time by 40%."',
        },
      ],
      drills: [
        {
          focus: 'Quantifying results',
          exercise: 'Retell a project in four sentences and make the last one a number.',
        },
      ],
      studyPlan: 'Start with the endings — fix the result on each story, then pull the "we" apart.',
    });

    expect(parsed.answerAdvice).toHaveLength(1);
    expect(parsed.answerAdvice[0]!.question).toContain('technical decision');
    expect(parsed.drills[0]!.focus).toBe('Quantifying results');
  });

  it('defaults advice and drills to empty and keeps the study plan a string', () => {
    const parsed = coachReportSchema.parse({ summary: '', studyPlan: '' });

    expect(parsed.answerAdvice).toEqual([]);
    expect(parsed.drills).toEqual([]);
    expect(parsed.studyPlan).toBe('');
  });
});
