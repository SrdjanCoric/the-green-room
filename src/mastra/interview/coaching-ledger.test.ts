import { describe, expect, it } from 'vitest';

import { coachReportSchema, sessionGradeSchema } from '../schemas/coach-report';
import { roleContextSchema } from '../schemas/role-context';
import {
  SESSION_LEDGER_CAP,
  candidateWorkingMemorySchema,
  computeSessionSummary,
  parseCandidateWorkingMemory,
  renderPriorSessions,
  upsertSessionSummary,
  type SessionSummary,
} from './coaching-ledger';

function score(turnIndex: number, value: number, gap: string) {
  return {
    question: `Question ${turnIndex + 1}`,
    turnIndex,
    rationale: 'rationale',
    star: { situation: true, task: true, action: true, result: false, quantifiedResult: false },
    specificity: 'some',
    ownership: 'some',
    weakOrMissing: [],
    gap,
    score: value,
  };
}

const grade = sessionGradeSchema.parse({
  scores: [score(0, 4, 'Strong story, missing the number.'), score(1, 2, 'Never named the result.'), score(2, 3, 'Ownership blurred into we.')],
  skipped: [],
});

const coaching = coachReportSchema.parse({
  summary: 'summary',
  answerAdvice: [],
  drills: [
    { focus: 'Quantifying results', exercise: 'End on a number.' },
    { focus: 'Ownership', exercise: 'Say I, not we.' },
  ],
  studyPlan: 'plan',
});

describe('computeSessionSummary', () => {
  it('distills the session: role, counts, mean score, lowest-score gaps, drill foci', () => {
    const summary = computeSessionSummary({
      runId: 'run-1',
      date: '2026-07-07T10:00:00.000Z',
      roleContext: roleContextSchema.parse({ company: 'Globex', role: 'Staff Engineer' }),
      transcriptLength: 3,
      grade,
      coaching,
    });

    expect(summary).toMatchObject({
      runId: 'run-1',
      date: '2026-07-07T10:00:00.000Z',
      role: 'Staff Engineer @ Globex',
      questionCount: 3,
      averageScore: 3,
    });
    // Gaps come from the lowest-scoring answers first.
    expect(summary.topGaps[0]).toBe('Never named the result.');
    expect(summary.topGaps).toHaveLength(3);
    expect(summary.drillFoci).toEqual(['Quantifying results', 'Ownership']);
  });

  it('caps gaps and drill foci at three and skips blank gaps', () => {
    // A perfect answer may carry no gap note — it must be skipped, not surface as ''.
    const bigGrade = sessionGradeSchema.parse({
      scores: [
        score(0, 1, 'gap a'),
        score(1, 5, ''),
        score(2, 2, 'gap b'),
        score(3, 3, 'gap c'),
        score(4, 4, 'gap d'),
      ],
      skipped: [],
    });
    const manyDrills = coachReportSchema.parse({
      summary: '',
      answerAdvice: [],
      drills: [
        { focus: 'one', exercise: 'x' },
        { focus: 'two', exercise: 'x' },
        { focus: 'three', exercise: 'x' },
        { focus: 'four', exercise: 'x' },
      ],
      studyPlan: '',
    });

    const summary = computeSessionSummary({
      runId: 'run-2',
      date: '2026-07-07T10:00:00.000Z',
      roleContext: roleContextSchema.parse({ role: 'Engineer' }),
      transcriptLength: 5,
      grade: bigGrade,
      coaching: manyDrills,
    });

    expect(summary.topGaps).toEqual(['gap a', 'gap b', 'gap c']);
    expect(summary.drillFoci).toEqual(['one', 'two', 'three']);
    expect(summary.role).toBe('Engineer');
    expect(summary.averageScore).toBe(3);
  });
});

function stubSummary(runId: string, date: string): SessionSummary {
  return {
    runId,
    date,
    role: 'Engineer',
    questionCount: 1,
    averageScore: 3,
    topGaps: [],
    drillFoci: [],
  };
}

describe('upsertSessionSummary', () => {
  it('appends a new session and replaces an existing one by runId', () => {
    const first = stubSummary('run-1', '2026-07-01T00:00:00.000Z');
    const second = stubSummary('run-2', '2026-07-02T00:00:00.000Z');

    const appended = upsertSessionSummary([first], second);
    expect(appended.map((s) => s.runId)).toEqual(['run-1', 'run-2']);

    // A recoach replay re-records its own session: same runId updates in place,
    // never double-appends.
    const updated = upsertSessionSummary(appended, { ...first, averageScore: 5 });
    expect(updated.map((s) => s.runId)).toEqual(['run-1', 'run-2']);
    expect(updated[0]?.averageScore).toBe(5);
  });

  it('drops the oldest entries beyond the cap', () => {
    let sessions: SessionSummary[] = [];
    for (let i = 0; i < SESSION_LEDGER_CAP + 2; i += 1) {
      sessions = upsertSessionSummary(sessions, stubSummary(`run-${i}`, `2026-06-${10 + i}T00:00:00.000Z`));
    }

    expect(sessions).toHaveLength(SESSION_LEDGER_CAP);
    expect(sessions[0]?.runId).toBe('run-2');
    expect(sessions.at(-1)?.runId).toBe(`run-${SESSION_LEDGER_CAP + 1}`);
  });
});

describe('parseCandidateWorkingMemory', () => {
  it('parses the { profile, sessions } shape', () => {
    const parsed = parseCandidateWorkingMemory(
      JSON.stringify({ profile: { name: 'Ada Lovelace' }, sessions: [stubSummary('run-1', '2026-07-01T00:00:00.000Z')] }),
    );
    expect(parsed?.profile.name).toBe('Ada Lovelace');
    expect(parsed?.sessions).toHaveLength(1);
  });

  it('reads a legacy bare-profile record as a ledger with no sessions', () => {
    const parsed = parseCandidateWorkingMemory(JSON.stringify({ name: 'Grace Hopper' }));
    expect(parsed?.profile.name).toBe('Grace Hopper');
    expect(parsed?.sessions).toEqual([]);
  });

  it('returns undefined for null or unparseable content', () => {
    expect(parseCandidateWorkingMemory(null)).toBeUndefined();
    expect(parseCandidateWorkingMemory('not json')).toBeUndefined();
  });
});

describe('renderPriorSessions', () => {
  it('renders one line per session with the distilled facts', () => {
    const text = renderPriorSessions([
      {
        runId: 'run-1',
        date: '2026-07-01T09:00:00.000Z',
        role: 'Staff Engineer @ Globex',
        questionCount: 4,
        averageScore: 3.2,
        topGaps: ['Never named the result.'],
        drillFoci: ['Quantifying results'],
      },
    ]);

    expect(text).toContain('2026-07-01');
    expect(text).toContain('Staff Engineer @ Globex');
    expect(text).toContain('4 questions');
    expect(text).toContain('3.2/5');
    expect(text).toContain('Never named the result.');
    expect(text).toContain('Quantifying results');
  });
});

describe('candidateWorkingMemorySchema', () => {
  it('bounds the ledger at the cap', () => {
    const sessions = Array.from({ length: SESSION_LEDGER_CAP + 1 }, (_, i) =>
      stubSummary(`run-${i}`, '2026-07-01T00:00:00.000Z'),
    );
    const result = candidateWorkingMemorySchema.safeParse({ profile: { name: 'A' }, sessions });
    expect(result.success).toBe(false);
  });
});
