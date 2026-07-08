import { describe, expect, it } from 'vitest';

import { initialInterviewState, interviewReducer } from './interviewMachine';
import type { InterviewReport } from './types';

const report: InterviewReport = {
  coaching: { summary: 'Solid.', answerAdvice: [], drills: [], studyPlan: 'Keep going.' },
  transcript: [{ question: 'Q1', answer: 'A1' }],
  targetLevel: 'staff',
};

describe('interviewReducer', () => {
  it('starts a run, clearing prior state and recording the runId', () => {
    const dirty = { ...initialInterviewState, error: 'old', transcript: [{ question: 'x', answer: 'y' }] };

    const next = interviewReducer(dirty, { type: 'START', runId: 'run-1' });

    expect(next.phase).toBe('starting');
    expect(next.runId).toBe('run-1');
    expect(next.transcript).toEqual([]);
    expect(next.error).toBeNull();
  });

  it('shows a between-turns cue while the workflow works', () => {
    const started = interviewReducer(initialInterviewState, { type: 'START', runId: 'r' });

    const next = interviewReducer(started, {
      type: 'EVENT',
      event: { type: 'cue', label: 'Choosing the next question…' },
    });

    expect(next.cue).toBe('Choosing the next question…');
  });

  it('streams question tokens incrementally and clears the cue', () => {
    let state = interviewReducer(initialInterviewState, { type: 'START', runId: 'r' });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'cue', label: 'Writing…' } });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'question-delta', text: 'Walk me ' } });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'question-delta', text: 'through it.' } });

    expect(state.phase).toBe('streamingQuestion');
    expect(state.currentQuestion).toBe('Walk me through it.');
    expect(state.cue).toBeNull();
  });

  it('drops a failed attempt’s partial text when a retried reply starts over', () => {
    let state = interviewReducer(initialInterviewState, { type: 'START', runId: 'r' });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'question-delta', text: 'Walk me thr' } });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'question-start' } });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'question-delta', text: 'Walk me through it.' } });

    expect(state.currentQuestion).toBe('Walk me through it.');
  });

  it('settles on the authoritative question text when the run suspends', () => {
    let state = interviewReducer(initialInterviewState, { type: 'START', runId: 'r' });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'question-delta', text: 'partial' } });
    state = interviewReducer(state, {
      type: 'EVENT',
      event: { type: 'suspended', suspend: { kind: 'question', question: 'Full question?', questionNumber: 2 } },
    });

    expect(state.phase).toBe('awaitingAnswer');
    expect(state.currentQuestion).toBe('Full question?');
    expect(state.currentQuestionNumber).toBe(2);
  });

  it('enters the level prompt when the run suspends for a target level', () => {
    let state = interviewReducer(initialInterviewState, { type: 'START', runId: 'r' });
    state = interviewReducer(state, {
      type: 'EVENT',
      event: { type: 'suspended', suspend: { kind: 'level', prompt: 'What level?' } },
    });

    expect(state.phase).toBe('awaitingLevel');
    expect(state.levelPrompt).toBe('What level?');
  });

  it('records the answered turn and shows the assessing cue on submit', () => {
    let state = interviewReducer(initialInterviewState, { type: 'START', runId: 'r' });
    state = interviewReducer(state, {
      type: 'EVENT',
      event: { type: 'suspended', suspend: { kind: 'question', question: 'Proudest work?', questionNumber: 1 } },
    });

    state = interviewReducer(state, { type: 'SUBMIT_ANSWER', answer: 'The migration.' });

    expect(state.phase).toBe('assessing');
    expect(state.transcript).toEqual([{ question: 'Proudest work?', answer: 'The migration.' }]);
    expect(state.currentQuestion).toBe('');
    expect(state.cue).toMatch(/weighing/i);
  });

  it('streams report tokens then settles on the structured report', () => {
    let state = interviewReducer(initialInterviewState, { type: 'START', runId: 'r' });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'report-delta', text: 'You perform ' } });
    expect(state.phase).toBe('grading');
    expect(state.reportPreview).toBe('You perform ');

    state = interviewReducer(state, { type: 'EVENT', event: { type: 'completed', report } });
    expect(state.phase).toBe('report');
    expect(state.report).toEqual(report);
  });

  it('captures a failure', () => {
    const state = interviewReducer(initialInterviewState, {
      type: 'EVENT',
      event: { type: 'failed', message: 'Run failed.' },
    });

    expect(state.phase).toBe('error');
    expect(state.error).toBe('Run failed.');
  });

  it('holds a failed turn as retryable rather than dead, then retries it', () => {
    let state = interviewReducer(initialInterviewState, { type: 'START', runId: 'run-1' });
    state = interviewReducer(state, {
      type: 'EVENT',
      event: {
        type: 'suspended',
        suspend: { kind: 'failure', reason: 'The assessor call failed.' },
      },
    });

    // The turn failed but the run is alive: recoverable phase, reason shown, no report.
    expect(state.phase).toBe('turnFailed');
    expect(state.error).toBe('The assessor call failed.');

    state = interviewReducer(state, { type: 'RETRY' });
    expect(state.phase).toBe('assessing');
    expect(state.error).toBeNull();
    expect(state.cue).toMatch(/retry/i);
  });
});
