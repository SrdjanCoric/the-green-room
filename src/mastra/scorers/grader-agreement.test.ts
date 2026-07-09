import { createTestMessage } from '@mastra/evals/scorers/utils';
import { describe, expect, it } from 'vitest';

import {
  evaluateTranscriptAgreement,
  extractGrade,
  graderAgreementScorer,
} from './grader-agreement';
import {
  agreeingGrade,
  driftedGrade,
  graderCaseExpectation,
} from './__fixtures__/grader-cases';
import type { SessionGrade } from '../schemas/coach-report';

/** Build the run output the grader agent hands a scorer: an assistant message array. */
function gradeOutput(grade: SessionGrade | string) {
  const content = typeof grade === 'string' ? grade : JSON.stringify(grade);
  return [createTestMessage({ content, role: 'assistant' })];
}

describe('grader agreement scorer', () => {
  it('scores a grade that meets every labeled expectation a full 1', async () => {
    const result = await graderAgreementScorer.run({
      output: gradeOutput(agreeingGrade),
      groundTruth: graderCaseExpectation,
    });

    expect(result.score).toBe(1);
    expect(result.reason).toMatch(/agrees with the labels/i);
  });

  it('scores a drifted grade 0 and names exactly its three disagreements', async () => {
    const result = await graderAgreementScorer.run({
      output: gradeOutput(driftedGrade),
      groundTruth: graderCaseExpectation,
    });

    expect(result.score).toBe(0);
    // Under-leveled floor (turn 0), scored clarification (turn 1), and an un-penalized dodge (turn 3).
    expect(result.reason).toMatch(/floor turns 0/i);
    expect(result.reason).toMatch(/clarifying turns scored/i);
    expect(result.reason).toMatch(/dodge turns not scored a 1/i);

    // The drifted grade handles the ceiling turn correctly, so it drifts on exactly three.
    const { violations } = evaluateTranscriptAgreement(
      extractGrade(driftedGrade)!,
      graderCaseExpectation,
    );
    expect(violations).toHaveLength(3);
  });

  it('floors to 0 when no labeled expectations are provided', async () => {
    const result = await graderAgreementScorer.run({ output: gradeOutput(agreeingGrade) });

    expect(result.score).toBe(0);
    expect(result.reason).toMatch(/no labeled expectations/i);
  });
});

describe('evaluateTranscriptAgreement', () => {
  it('flags a turn scored more than once', () => {
    const grade = extractGrade(agreeingGrade)!;
    const duplicated = { ...grade, scores: [...grade.scores, grade.scores[0]!] };

    const result = evaluateTranscriptAgreement(duplicated, graderCaseExpectation);

    expect(result.value).toBe(0);
    expect(result.violations.some((v) => /scored more than once/i.test(v))).toBe(true);
  });

  it('flags a ceiling turn scored above 3', () => {
    const grade = extractGrade(agreeingGrade)!;
    const result = evaluateTranscriptAgreement(grade, {
      ...graderCaseExpectation,
      seniorCeilingTurns: [0], // turn 0 scored a 4, above the ceiling
    });

    expect(result.value).toBe(0);
    expect(result.violations.some((v) => /ceiling turns 0/i.test(v))).toBe(true);
  });
});
