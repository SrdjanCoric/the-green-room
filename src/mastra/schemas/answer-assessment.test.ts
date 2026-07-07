import { describe, expect, it } from 'vitest';

import { answerAssessmentSchema, topicAssessmentSchema } from './answer-assessment';

describe('answerAssessmentSchema', () => {
  it('accepts a full assessment with STAR flags, signal, and claims', () => {
    const parsed = answerAssessmentSchema.parse({
      star: {
        situation: true,
        task: true,
        action: true,
        result: true,
        quantifiedResult: false,
      },
      sufficientSignal: true,
      claimsWorthChasing: ['cut deploy time from an hour to ten minutes'],
    });

    expect(parsed.star.action).toBe(true);
    expect(parsed.sufficientSignal).toBe(true);
    expect(parsed.claimsWorthChasing).toHaveLength(1);
  });

  it('defaults claimsWorthChasing to an empty list when omitted', () => {
    const parsed = answerAssessmentSchema.parse({
      star: { situation: false, task: false, action: false, result: false, quantifiedResult: false },
      sufficientSignal: false,
    });

    expect(parsed.claimsWorthChasing).toEqual([]);
  });

  it('rejects an assessment missing a STAR flag', () => {
    const result = answerAssessmentSchema.safeParse({
      star: { situation: true, task: true, action: true, result: true },
      sufficientSignal: true,
    });

    expect(result.success).toBe(false);
  });
});

describe('topicAssessmentSchema', () => {
  it('pairs an assessment with the topic it was made on', () => {
    const parsed = topicAssessmentSchema.parse({
      topic: 'the payments migration',
      assessment: {
        star: { situation: true, task: true, action: true, result: false, quantifiedResult: false },
        sufficientSignal: false,
        claimsWorthChasing: [],
      },
    });

    expect(parsed.topic).toBe('the payments migration');
    expect(parsed.assessment.sufficientSignal).toBe(false);
  });
});
