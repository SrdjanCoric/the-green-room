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

  it('ignores the stale suspendPayload a completed step keeps in the run state', () => {
    // After the level is answered, collectLevel is success but still carries its old
    // payload; the currently suspended interview turn must win.
    const event = readOutcome({
      status: 'suspended',
      steps: {
        collectLevel: { status: 'success', suspendPayload: { kind: 'level', prompt: 'What level?' } },
        interviewTurn: {
          status: 'suspended',
          suspendPayload: { kind: 'question', question: 'First question?', questionNumber: 1 },
        },
      },
    });

    expect(event).toEqual({
      type: 'suspended',
      suspend: { kind: 'question', question: 'First question?', questionNumber: 1 },
    });
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

  it('carries the authoritative complete closing from a successful run', () => {
    const event = readOutcome({
      status: 'success',
      result: {
        closingMessage: 'Thanks for walking me through the migration today.',
        transcript: [],
        coaching: {
          summary: 'Solid.',
          answerAdvice: [],
          drills: [],
          studyPlan: 'Keep going.',
        },
      },
    });

    expect(event).toMatchObject({
      type: 'completed',
      closingMessage: 'Thanks for walking me through the migration today.',
    });
  });

  it('populates role and company from the real workflow result field (roleContext)', () => {
    // The workflow result carries the role under `roleContext` (roleContextSchema),
    // never a bare `role`. A run that resolved a posting must surface both onto the
    // report the sidebar and screen meta read.
    const event = readOutcome({
      status: 'success',
      result: {
        targetLevel: 'senior',
        reportPath: '/data/reports/y.md',
        transcript: [{ question: 'Q1', answer: 'A1' }],
        roleContext: {
          company: 'Globex',
          role: 'Staff Engineer',
          competencies: [{ name: 'System design', weight: 5 }],
        },
        coaching: {
          summary: 'Solid.',
          answerAdvice: [],
          drills: [],
          studyPlan: 'Keep going.',
        },
      },
    });

    expect(event).toMatchObject({
      type: 'completed',
      report: { role: 'Staff Engineer', company: 'Globex' },
    });
  });

  it('reports a failure with the error message', () => {
    const event = readOutcome({ status: 'failed', error: { message: 'boom' } });
    expect(event).toEqual({ type: 'failed', message: 'boom' });
  });

  it('falls back to a generic message when a failure carries no detail', () => {
    const event = readOutcome({ status: 'failed' });
    expect(event).toMatchObject({ type: 'failed' });
    if (event?.type === 'failed') expect(event.message).toMatch(/interview/i);
  });
});
