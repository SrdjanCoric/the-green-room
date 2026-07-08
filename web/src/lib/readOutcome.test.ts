import { describe, expect, it } from 'vitest';

import { readOutcome } from './readOutcome';

describe('readOutcome', () => {
  it('returns null while the run is still going', () => {
    expect(readOutcome({ status: 'running' })).toBeNull();
    expect(readOutcome({ status: 'waiting' })).toBeNull();
    expect(readOutcome(undefined)).toBeNull();
  });

  it('reads a question suspend from a top-level suspendPayload (stream result shape)', () => {
    const event = readOutcome({
      status: 'suspended',
      suspendPayload: { kind: 'question', question: 'Proudest work?', questionNumber: 1, subject: '' },
    });

    expect(event).toEqual({
      type: 'suspended',
      suspend: { kind: 'question', question: 'Proudest work?', questionNumber: 1 },
    });
  });

  it('reads a suspend when suspendPayload is keyed by step id (real stream-result shape)', () => {
    const event = readOutcome({
      status: 'suspended',
      suspendPayload: {
        interviewLoop: { kind: 'question', question: 'Keyed question?', questionNumber: 3 },
      },
    });

    expect(event).toEqual({
      type: 'suspended',
      suspend: { kind: 'question', question: 'Keyed question?', questionNumber: 3 },
    });
  });

  it('reads a failure suspend so a failed turn is terminal for polling and retryable', () => {
    const event = readOutcome({
      status: 'suspended',
      suspendPayload: {
        interviewLoop: {
          kind: 'failure',
          reason: 'The director call failed; run the resume command to retry this turn.',
          stage: 'director',
        },
      },
    });

    expect(event).toEqual({
      type: 'suspended',
      suspend: {
        kind: 'failure',
        reason: 'The director call failed; run the resume command to retry this turn.',
      },
    });
  });

  it('reads a level suspend from a suspended step (runById state shape)', () => {
    const event = readOutcome({
      status: 'suspended',
      steps: {
        ingest: { status: 'success' },
        collectLevel: { status: 'suspended', suspendPayload: { kind: 'level', prompt: 'What level?' } },
      },
    });

    expect(event).toEqual({ type: 'suspended', suspend: { kind: 'level', prompt: 'What level?' } });
  });

  it('maps a successful result into the report the screen renders', () => {
    const event = readOutcome({
      status: 'success',
      result: {
        targetLevel: 'staff',
        reportPath: '/data/reports/x.md',
        transcript: [{ question: 'Q1', answer: 'A1' }],
        coaching: {
          summary: 'Strong material.',
          answerAdvice: [{ question: 'Q1', diagnosis: 'No number.', fix: 'Add a metric.' }],
          drills: [{ focus: 'Landing the result', exercise: 'Write the last line.' }],
          studyPlan: 'Quantify every story.',
        },
      },
    });

    expect(event).toEqual({
      type: 'completed',
      report: {
        coaching: {
          summary: 'Strong material.',
          answerAdvice: [{ question: 'Q1', diagnosis: 'No number.', fix: 'Add a metric.' }],
          drills: [{ focus: 'Landing the result', exercise: 'Write the last line.' }],
          studyPlan: 'Quantify every story.',
        },
        transcript: [{ question: 'Q1', answer: 'A1' }],
        targetLevel: 'staff',
        reportPath: '/data/reports/x.md',
      },
    });
  });

  it('reports a failure with the error message', () => {
    const event = readOutcome({ status: 'failed', error: { message: 'boom' } });
    expect(event).toEqual({ type: 'failed', message: 'boom' });
  });

  it('falls back to a generic message when a failure carries no detail', () => {
    const event = readOutcome({ status: 'failed' });
    expect(event).toEqual({ type: 'failed', message: expect.stringMatching(/interview/i) });
  });
});
