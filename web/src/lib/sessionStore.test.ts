import { beforeEach, describe, expect, it } from 'vitest';

import type { InterviewState } from './interviewMachine';
import { clearSession, loadSession, saveSession } from './sessionStore';

const RUN_ID = 'run-42';

function liveState(): InterviewState {
  return {
    phase: 'awaitingAnswer',
    runId: RUN_ID,
    transcript: [{ question: 'Tell me about a conflict.', answer: 'I mediated it.' }],
    currentQuestion: 'What did you learn?',
    currentQuestionNumber: 2,
    levelPrompt: null,
    cue: null,
    closingMessage: '',
    closingRevealed: false,
    reportPreview: '',
    report: null,
    error: null,
  };
}

describe('sessionStore', () => {
  beforeEach(() => window.localStorage.clear());

  it('round-trips the interview state for a run', () => {
    saveSession(window.localStorage, RUN_ID, liveState());

    expect(loadSession(window.localStorage, RUN_ID)).toEqual(liveState());
  });

  it('returns null for a run with no saved session', () => {
    expect(loadSession(window.localStorage, 'unknown-run')).toBeNull();
  });

  it('tolerates a corrupt saved session', () => {
    window.localStorage.setItem('green-room:session:run-42', '{not json');

    expect(loadSession(window.localStorage, RUN_ID)).toBeNull();
  });

  it('clears a saved session', () => {
    saveSession(window.localStorage, RUN_ID, liveState());
    clearSession(window.localStorage, RUN_ID);

    expect(loadSession(window.localStorage, RUN_ID)).toBeNull();
  });
});
