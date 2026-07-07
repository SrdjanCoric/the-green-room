import { describe, expect, it } from 'vitest';

import { capLimitsSchema, coverageStateSchema } from '../interview/interview-caps';
import { candidateProfileSchema } from '../schemas/candidate-profile';
import { coachReportSchema } from '../schemas/coach-report';
import { EMPTY_COMPANY_BRIEF } from '../schemas/company-brief';
import { roleContextSchema } from '../schemas/role-context';
import {
  asInterviewSuspend,
  interviewComplete,
  readSuspendPayload,
  reportedInterviewStateSchema,
} from './interview-state';

describe('interviewComplete', () => {
  const limits = capLimitsSchema.parse({
    maxQuestions: 2,
    maxConsecutiveFollowUps: 2,
    maxReprompts: 1,
    tokenBudget: 1000,
  });

  it('is false while the question cap has headroom', () => {
    expect(
      interviewComplete({ coverage: coverageStateSchema.parse({ questionCount: 1 }), limits }),
    ).toBe(false);
  });

  it('is true once the question cap is reached', () => {
    expect(
      interviewComplete({ coverage: coverageStateSchema.parse({ questionCount: 2 }), limits }),
    ).toBe(true);
  });
});

describe('reportedInterviewStateSchema', () => {
  it('rejects a grade that does not cover the transcript exactly once', () => {
    const result = reportedInterviewStateSchema.safeParse({
      profile: candidateProfileSchema.parse({ name: 'Ada Lovelace' }),
      roleContext: roleContextSchema.parse({ role: 'Staff Engineer' }),
      researchUrls: [],
      companyBrief: EMPTY_COMPANY_BRIEF,
      targetLevel: 'senior',
      transcript: [{ question: 'Question', answer: 'Answer' }],
      assessments: [],
      currentTopic: '',
      coverage: coverageStateSchema.parse({ questionCount: 1 }),
      limits: capLimitsSchema.parse({
        maxQuestions: 1,
        maxConsecutiveFollowUps: 1,
        maxReprompts: 1,
        tokenBudget: 1000,
      }),
      done: true,
      closingMessage: 'Thanks.',
      grade: { scores: [], skipped: [] },
      coaching: coachReportSchema.parse({ summary: '', studyPlan: '' }),
      reportPath: 'data/reports/example.md',
      reportGeneratedAt: '2026-07-07T09:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('accepts a grade that covers every transcript turn exactly once', () => {
    const result = reportedInterviewStateSchema.safeParse({
      profile: candidateProfileSchema.parse({ name: 'Ada Lovelace' }),
      roleContext: roleContextSchema.parse({ role: 'Staff Engineer' }),
      researchUrls: [],
      companyBrief: EMPTY_COMPANY_BRIEF,
      targetLevel: 'senior',
      transcript: [{ question: 'Question', answer: 'Answer' }],
      assessments: [],
      currentTopic: '',
      coverage: coverageStateSchema.parse({ questionCount: 1 }),
      limits: capLimitsSchema.parse({
        maxQuestions: 1,
        maxConsecutiveFollowUps: 1,
        maxReprompts: 1,
        tokenBudget: 1000,
      }),
      done: true,
      closingMessage: 'Thanks.',
      grade: {
        scores: [
          {
            question: 'Question',
            turnIndex: 0,
            rationale: 'The answer has some evidence.',
            star: {
              situation: false,
              task: true,
              action: true,
              result: true,
              quantifiedResult: false,
            },
            specificity: 'Names the migration.',
            ownership: 'The candidate says I.',
            weakOrMissing: ['No quantified result'],
            gap: 'Add the result number.',
            score: 3,
          },
        ],
        skipped: [],
      },
      coaching: coachReportSchema.parse({ summary: '', studyPlan: '' }),
      reportPath: 'data/reports/example.md',
      reportGeneratedAt: '2026-07-07T09:00:00.000Z',
    });

    expect(result.success).toBe(true);
  });
});

describe('asInterviewSuspend', () => {
  it('narrows a level payload and a full question payload', () => {
    expect(asInterviewSuspend({ kind: 'level', prompt: 'Level?' })).toMatchObject({ kind: 'level' });
    expect(
      asInterviewSuspend({ kind: 'question', question: 'Q1', questionNumber: 1, action: 'new_topic' }),
    ).toMatchObject({ kind: 'question', subject: '' });
  });

  it('rejects unknown kinds and structurally invalid payloads instead of casting them through', () => {
    expect(asInterviewSuspend({ kind: 'other' })).toBeUndefined();
    expect(asInterviewSuspend(null)).toBeUndefined();
    // A question payload missing its director action is malformed, not trusted.
    expect(asInterviewSuspend({ kind: 'question', question: 'Q1' })).toBeUndefined();
  });
});

describe('readSuspendPayload', () => {
  it('returns the first value that narrows to the interview union', () => {
    const payload = readSuspendPayload({
      unrelated: { anything: true },
      interviewTurn: { kind: 'question', question: 'Q1', questionNumber: 1, action: 'reprompt' },
    });
    expect(payload).toMatchObject({ kind: 'question', question: 'Q1' });
  });

  it('returns undefined when nothing narrows', () => {
    expect(readSuspendPayload({ x: { kind: 'other' } })).toBeUndefined();
    expect(readSuspendPayload(undefined)).toBeUndefined();
  });
});
