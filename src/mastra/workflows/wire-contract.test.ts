import { describe, expect, it } from 'vitest';

import {
  interviewReportResultSchema,
  type CoachReport,
  type RoleContext,
  type TranscriptEntry,
} from '../../../shared/wire-contract';

import type { ReportedInterviewState } from './interview-state';

describe('wire contract ↔ workflow result', () => {
  it('exposes the fields the web report reads under their contract names', () => {
    // The web report reads `coaching`, `transcript`, and `roleContext` off the
    // finished-run result via the shared schema. This projection reads the same fields
    // off `ReportedInterviewState`; its return-type annotation and body only compile
    // while the workflow state exposes those exact names, so a rename breaks the build
    // here (and, because the web imports the same shared schema, the web build too)
    // rather than silently rendering nothing.
    const project = (
      state: ReportedInterviewState,
    ): { coaching: CoachReport; transcript: TranscriptEntry[]; roleContext: RoleContext } => ({
      coaching: state.coaching,
      transcript: state.transcript,
      roleContext: state.roleContext,
    });

    // And exercise it, so the assertion turns on real projected values rather than the
    // mere existence of the function.
    const state = {
      coaching: { summary: 'Solid.', answerAdvice: [], drills: [], studyPlan: 'Keep at it.' },
      transcript: [{ question: 'Q1', answer: 'A1' }],
      roleContext: { role: 'Staff Engineer', company: 'Globex', competencies: [] },
    } as unknown as ReportedInterviewState;

    const projected = project(state);

    expect(projected.roleContext.role).toBe('Staff Engineer');
    expect(projected.roleContext.company).toBe('Globex');
    expect(projected.transcript).toEqual([{ question: 'Q1', answer: 'A1' }]);
    expect(projected.coaching.summary).toBe('Solid.');
  });

  it('parses a finished-run result down to just the report the screen renders', () => {
    const result = {
      coaching: { summary: 'Solid.', answerAdvice: [], drills: [], studyPlan: 'Keep going.' },
      transcript: [{ question: 'Q', answer: 'A' }],
      roleContext: { role: 'Staff Engineer', company: 'Globex', competencies: [] },
      targetLevel: 'senior',
      reportPath: '/data/reports/x.md',
      // The real result carries far more (grade, assessments, coverage); the wire schema
      // ignores everything it does not need.
      grade: { scores: [], skipped: [] },
    };

    const parsed = interviewReportResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.roleContext?.role).toBe('Staff Engineer');
      expect(parsed.data.roleContext?.company).toBe('Globex');
    }
  });
});
