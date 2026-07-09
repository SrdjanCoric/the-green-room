import { beforeEach, describe, expect, it } from 'vitest';

import { cacheReport, loadCachedReport } from './reportCache';
import type { InterviewReport } from './types';

const RUN_ID = 'run-report-1';

function report(): InterviewReport {
  return {
    coaching: {
      summary: 'Strong material.',
      answerAdvice: [{ question: 'Q1', diagnosis: 'No number.', fix: 'Add a metric.' }],
      drills: [{ focus: 'Landing the result', exercise: 'Write the last line.' }],
      studyPlan: 'Quantify every story.',
    },
    transcript: [{ question: 'Q1', answer: 'A1' }],
    targetLevel: 'staff',
    role: 'Staff Engineer',
    company: 'Globex',
  };
}

describe('reportCache', () => {
  beforeEach(() => window.localStorage.clear());

  it('round-trips a cached report', () => {
    cacheReport(window.localStorage, RUN_ID, report());
    expect(loadCachedReport(window.localStorage, RUN_ID)).toEqual(report());
  });

  it('returns null for an absent report', () => {
    expect(loadCachedReport(window.localStorage, 'missing')).toBeNull();
  });

  it('returns null on corrupt JSON instead of throwing', () => {
    window.localStorage.setItem(`green-room:report:${RUN_ID}`, '{not json');
    expect(loadCachedReport(window.localStorage, RUN_ID)).toBeNull();
  });

  it('returns null on well-formed JSON of the wrong shape (a stale schema)', () => {
    // Valid JSON, but missing the coaching notes the report screen renders.
    window.localStorage.setItem(
      `green-room:report:${RUN_ID}`,
      JSON.stringify({ transcript: [{ question: 'Q', answer: 'A' }] }),
    );
    expect(loadCachedReport(window.localStorage, RUN_ID)).toBeNull();
  });

  it('does not throw when the store is full', () => {
    const full: Storage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    };
    expect(() => cacheReport(full, RUN_ID, report())).not.toThrow();
  });
});
