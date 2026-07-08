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

  it('streams the closing goodbye after the last answer, clearing the cue', () => {
    let state = interviewReducer(initialInterviewState, { type: 'START', runId: 'r' });
    state = interviewReducer(state, {
      type: 'EVENT',
      event: { type: 'suspended', suspend: { kind: 'question', question: 'Proudest work?', questionNumber: 1 } },
    });
    state = interviewReducer(state, { type: 'SUBMIT_ANSWER', answer: 'The migration.' });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'cue', label: 'Wrapping up…' } });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'closing-start' } });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'closing-delta', text: 'Thanks for ' } });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'closing-delta', text: 'today.' } });

    expect(state.phase).toBe('closing');
    expect(state.closingMessage).toBe('Thanks for today.');
    expect(state.cue).toBeNull();
  });

  it('drops a failed closing attempt’s partial text when a retried goodbye starts over', () => {
    let state = interviewReducer(initialInterviewState, { type: 'START', runId: 'r' });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'closing-delta', text: 'Thanks fo' } });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'closing-start' } });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'closing-delta', text: 'Thanks for today.' } });

    expect(state.closingMessage).toBe('Thanks for today.');
  });

  it('marks the goodbye revealed only when the screen reports it, and re-arms on new text', () => {
    let state = interviewReducer(initialInterviewState, { type: 'START', runId: 'r' });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'closing-delta', text: 'Thanks ' } });
    expect(state.closingRevealed).toBe(false);

    state = interviewReducer(state, { type: 'CLOSING_REVEALED' });
    expect(state.closingRevealed).toBe(true);

    // More goodbye text arrives after a premature catch-up: the reveal re-arms.
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'closing-delta', text: 'for today.' } });
    expect(state.closingRevealed).toBe(false);

    state = interviewReducer(state, { type: 'CLOSING_REVEALED' });
    // A retried goodbye starts over: the reveal must re-arm with the text.
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'closing-start' } });
    expect(state.closingRevealed).toBe(false);
  });

  it('keeps the goodbye on screen while grading streams the report', () => {
    let state = interviewReducer(initialInterviewState, { type: 'START', runId: 'r' });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'closing-delta', text: 'Thanks for today.' } });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'cue', label: 'Grading your answers…' } });
    state = interviewReducer(state, { type: 'EVENT', event: { type: 'report-delta', text: 'You perform ' } });

    expect(state.phase).toBe('grading');
    expect(state.closingMessage).toBe('Thanks for today.');
    expect(state.reportPreview).toBe('You perform ');
  });

  it('returns to the working scene after the level pick, never the loading screen', () => {
    let state = interviewReducer(initialInterviewState, { type: 'START', runId: 'r' });
    state = interviewReducer(state, {
      type: 'EVENT',
      event: { type: 'suspended', suspend: { kind: 'level', prompt: 'What level?' } },
    });

    state = interviewReducer(state, { type: 'SUBMIT_LEVEL' });

    // Setup is over: the loading screen (the 'starting' phase) must not reappear.
    expect(state.phase).not.toBe('starting');
    expect(state.levelPrompt).toBeNull();
    expect(state.cue).toMatch(/choosing the next question/i);
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

  it('reconnects by hydrating the saved snapshot for the run', () => {
    const snapshot = {
      ...initialInterviewState,
      phase: 'awaitingAnswer' as const,
      runId: 'run-1',
      transcript: [{ question: 'Q1', answer: 'A1' }],
      currentQuestion: 'Q2?',
      currentQuestionNumber: 2,
    };

    const state = interviewReducer(initialInterviewState, {
      type: 'RECONNECT',
      runId: 'run-1',
      snapshot,
    });

    expect(state.phase).toBe('awaitingAnswer');
    expect(state.runId).toBe('run-1');
    expect(state.transcript).toEqual([{ question: 'Q1', answer: 'A1' }]);
    expect(state.currentQuestion).toBe('Q2?');
    expect(state.currentQuestionNumber).toBe(2);
  });

  it('reconnects cold (no snapshot) into a starting phase with a reconnect cue', () => {
    const state = interviewReducer(initialInterviewState, {
      type: 'RECONNECT',
      runId: 'run-9',
      snapshot: null,
    });

    expect(state.phase).toBe('starting');
    expect(state.runId).toBe('run-9');
    expect(state.transcript).toEqual([]);
    expect(state.cue).toMatch(/reconnect/i);
  });

  it('rehydrates an error-phase snapshot into a reconnecting state, keeping the transcript', () => {
    // The persist effect also saves at the error transition; rejoining must show
    // the reconnect in progress, not re-render the stale error screen.
    const snapshot = {
      ...initialInterviewState,
      phase: 'error' as const,
      runId: 'run-1',
      transcript: [{ question: 'Q1?', answer: 'A1.' }],
      error: 'network dropped',
    };

    const state = interviewReducer(initialInterviewState, {
      type: 'RECONNECT',
      runId: 'run-1',
      snapshot,
    });

    expect(state.phase).toBe('starting');
    expect(state.error).toBeNull();
    expect(state.cue).toMatch(/reconnect/i);
    expect(state.transcript).toEqual([{ question: 'Q1?', answer: 'A1.' }]);
  });

  it('trusts the run id it reconnected with over a stale snapshot field', () => {
    const snapshot = { ...initialInterviewState, phase: 'grading' as const, runId: 'other-run' };

    const state = interviewReducer(initialInterviewState, {
      type: 'RECONNECT',
      runId: 'run-1',
      snapshot,
    });

    expect(state.runId).toBe('run-1');
    expect(state.phase).toBe('grading');
  });

  it('drops a transcript entry whose answer never reached the run when the same question re-suspends', () => {
    // Reload in the window between submitting an answer and the resume reaching the
    // server: the snapshot already shows the question answered, but the run is still
    // suspended on it. Settling on that same question must not leave it in the
    // transcript twice once it is answered again.
    const snapshot = {
      ...initialInterviewState,
      phase: 'assessing' as const,
      runId: 'run-1',
      transcript: [
        { question: 'Q1?', answer: 'A1.' },
        { question: 'Q2?', answer: 'The answer the run never got.' },
      ],
    };
    let state = interviewReducer(initialInterviewState, {
      type: 'RECONNECT',
      runId: 'run-1',
      snapshot,
    });

    state = interviewReducer(state, {
      type: 'EVENT',
      event: { type: 'suspended', suspend: { kind: 'question', question: 'Q2?', questionNumber: 2 } },
    });

    expect(state.transcript).toEqual([{ question: 'Q1?', answer: 'A1.' }]);
    expect(state.currentQuestion).toBe('Q2?');

    // Answering again records the turn exactly once.
    state = interviewReducer(state, { type: 'SUBMIT_ANSWER', answer: 'A2, again.' });
    expect(state.transcript).toEqual([
      { question: 'Q1?', answer: 'A1.' },
      { question: 'Q2?', answer: 'A2, again.' },
    ]);
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
