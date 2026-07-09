import { beforeEach, describe, expect, it } from 'vitest';

import type { InterviewState } from './interviewMachine';
import {
  clearRunMeta,
  clearSession,
  loadRunMeta,
  loadSession,
  saveRunMeta,
  saveSession,
} from './sessionStore';

const RUN_ID = 'run-42';

function liveState(): InterviewState {
  return {
    phase: 'awaitingAnswer',
    runId: RUN_ID,
    transcript: [{ question: 'Tell me about a conflict.', answer: 'I mediated it.' }],
    currentQuestion: 'What did you learn?',
    currentQuestionNumber: 2,
    lastAnsweredQuestionNumber: 1,
    levelPrompt: null,
    cue: null,
    closingMessage: '',
    closingRevealed: false,
    reportPreview: '',
    report: null,
    error: null,
  };
}

/** A Storage whose writes always fail — a full quota or Safari private mode. */
function fullStorage(): Storage {
  return {
    getItem: () => null,
    setItem: () => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    },
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  };
}

describe('sessionStore', () => {
  beforeEach(() => window.localStorage.clear());

  it('swallows a failed session write (full quota) instead of throwing into the caller', () => {
    // saveSession runs on the stream/phase path; a QuotaExceededError must degrade to
    // non-resumable, never propagate as a stream failure.
    expect(() => saveSession(fullStorage(), RUN_ID, liveState())).not.toThrow();
  });

  it('swallows a failed run-meta write (full quota) instead of throwing into the caller', () => {
    expect(() => saveRunMeta(fullStorage(), RUN_ID, { offset: 3 })).not.toThrow();
  });

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

  it('rejects a snapshot that is not interview-state shaped', () => {
    // A truncated write or a schema change must fall back to a cold reconnect,
    // never hydrate undefined fields into the reducer.
    window.localStorage.setItem('green-room:session:run-42', '{}');
    expect(loadSession(window.localStorage, RUN_ID)).toBeNull();

    window.localStorage.setItem(
      'green-room:session:run-42',
      JSON.stringify({ ...liveState(), phase: 'not-a-phase' }),
    );
    expect(loadSession(window.localStorage, RUN_ID)).toBeNull();

    window.localStorage.setItem(
      'green-room:session:run-42',
      JSON.stringify({ ...liveState(), transcript: 'oops' }),
    );
    expect(loadSession(window.localStorage, RUN_ID)).toBeNull();
  });
});

describe('run meta', () => {
  beforeEach(() => window.localStorage.clear());

  it('defaults to a zero offset with no context or floor', () => {
    expect(loadRunMeta(window.localStorage, RUN_ID)).toEqual({ offset: 0 });
  });

  it('round-trips offset, request context, and the staleness floor', () => {
    saveRunMeta(window.localStorage, RUN_ID, {
      offset: 12,
      requestContext: { 'model.fast': 'openai/gpt-fast', 'model.smart': 'openai/gpt-smart' },
      staleAsOf: 1720000000000,
    });

    expect(loadRunMeta(window.localStorage, RUN_ID)).toEqual({
      offset: 12,
      requestContext: { 'model.fast': 'openai/gpt-fast', 'model.smart': 'openai/gpt-smart' },
      staleAsOf: 1720000000000,
    });
  });

  it('tolerates a corrupt record and clears', () => {
    window.localStorage.setItem('green-room:run-meta:run-42', 'not json');
    expect(loadRunMeta(window.localStorage, RUN_ID)).toEqual({ offset: 0 });

    saveRunMeta(window.localStorage, RUN_ID, { offset: 3 });
    clearRunMeta(window.localStorage, RUN_ID);
    expect(loadRunMeta(window.localStorage, RUN_ID)).toEqual({ offset: 0 });
  });
});
