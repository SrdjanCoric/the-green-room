import { createScorer } from '@mastra/core/evals';
import { getAssistantMessageFromRunOutput } from '@mastra/evals/scorers/utils';
import { z } from 'zod';

/** The id the agreement scorer is registered and stored under (Studio + `mastra_scorers`). */
export const GRADER_AGREEMENT_SCORER_ID = 'grader-agreement';

/**
 * Human-labeled expectations for one graded transcript, checked as `groundTruth`. Turn
 * indices are zero-based, matching the grade's own `turnIndex`. Each list names the turns
 * a calibrated grader must handle a particular way:
 * - `seniorFloorTurns` — strong, well-owned answers that must score at least 4.
 * - `seniorCeilingTurns` — below-level answers that must score at most 3, so the scale
 *   still discriminates.
 * - `clarifyingTurns` / `declinedTurns` — turns with no answer of their own to grade
 *   (a bare clarification, or a legitimate decline); both must be skipped, not scored.
 * - `dodgeTurns` — fair questions the candidate evaded, which must score exactly 1.
 */
export const transcriptExpectationSchema = z.object({
  seniorFloorTurns: z.array(z.number().int().nonnegative()).default([]),
  seniorCeilingTurns: z.array(z.number().int().nonnegative()).default([]),
  clarifyingTurns: z.array(z.number().int().nonnegative()).default([]),
  declinedTurns: z.array(z.number().int().nonnegative()).default([]),
  dodgeTurns: z.array(z.number().int().nonnegative()).default([]),
});

export type TranscriptExpectation = z.infer<typeof transcriptExpectationSchema>;

/**
 * The slice of a grade the agreement check reads — the turn indices and scores it awards,
 * and the turns it skipped. Deliberately lenient (only these fields, tolerant of the rest)
 * so it reads a real grader's output whether handed the object, a JSON string, or the
 * assistant-message array a live agent run produces.
 */
const gradeShapeSchema = z.object({
  scores: z.array(z.object({ turnIndex: z.number(), score: z.number() })),
  skipped: z.array(z.object({ turnIndex: z.number() })).default([]),
});

type GradeShape = z.infer<typeof gradeShapeSchema>;

/** Pull the grade out of an object, a JSON string, or the assistant-message array. */
export function extractGrade(output: unknown): GradeShape | null {
  const candidate = coerceToGradeObject(output);
  if (candidate === null) return null;
  const parsed = gradeShapeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function coerceToGradeObject(output: unknown): unknown {
  if (typeof output === 'object' && output !== null && 'scores' in output) return output;
  const text = typeof output === 'string' ? output : getAssistantMessageFromRunOutput(output);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface AgreementResult {
  /** 1 when the grade respects every labeled expectation, 0 otherwise. */
  value: number;
  /** One phrase per broken expectation; empty when the grade agrees. */
  violations: string[];
}

/**
 * Score whether a grade respects a transcript's labeled expectations: the senior floor and
 * ceiling, the turns that must be skipped, the dodges that must score a 1, and no turn
 * scored twice. A single disagreement fails the case (value 0) with a named reason — the
 * point of an agreement eval is to catch calibration drift, not to average it away.
 */
export function evaluateTranscriptAgreement(
  grade: GradeShape,
  expectation: TranscriptExpectation,
): AgreementResult {
  const byTurn = new Map(grade.scores.map((entry) => [entry.turnIndex, entry.score]));
  const scoredTurns = grade.scores.map((entry) => entry.turnIndex);

  const duplicates = [...new Set(scoredTurns.filter((turn) => count(scoredTurns, turn) > 1))].sort(
    (a, b) => a - b,
  );
  const tooLow = expectation.seniorFloorTurns.filter((turn) => scoredBelow(byTurn, turn, 4));
  const tooHigh = expectation.seniorCeilingTurns.filter((turn) => scoredAbove(byTurn, turn, 3));
  const scoredClarifying = expectation.clarifyingTurns.filter((turn) => byTurn.has(turn));
  const scoredDeclined = expectation.declinedTurns.filter((turn) => byTurn.has(turn));
  const misScoredDodges = expectation.dodgeTurns.filter((turn) => byTurn.get(turn) !== 1);

  const violations: string[] = [];
  if (duplicates.length) violations.push(`turns scored more than once: ${duplicates.join(', ')}`);
  if (tooLow.length) violations.push(`under-leveled or unscored at floor turns ${tooLow.join(', ')}`);
  if (tooHigh.length) violations.push(`over-leveled or unscored at ceiling turns ${tooHigh.join(', ')}`);
  if (scoredClarifying.length)
    violations.push(`clarifying turns scored instead of skipped: ${scoredClarifying.join(', ')}`);
  if (scoredDeclined.length)
    violations.push(`declined turns scored instead of skipped: ${scoredDeclined.join(', ')}`);
  if (misScoredDodges.length)
    violations.push(`dodge turns not scored a 1: ${misScoredDodges.join(', ')}`);

  return { value: violations.length === 0 ? 1 : 0, violations };
}

function count<T>(items: T[], value: T): number {
  return items.filter((item) => item === value).length;
}

/** True when a required turn is unscored or scored below the floor. */
function scoredBelow(byTurn: Map<number, number>, turn: number, floor: number): boolean {
  const score = byTurn.get(turn);
  return score === undefined || score < floor;
}

/** True when a required turn is unscored or scored above the ceiling. */
function scoredAbove(byTurn: Map<number, number>, turn: number, ceiling: number): boolean {
  const score = byTurn.get(turn);
  return score === undefined || score > ceiling;
}

interface AgreementInputs {
  grade: GradeShape | null;
  expectation: TranscriptExpectation | null;
}

/**
 * A deterministic, model-free grader eval: it checks a grade against human-labeled
 * expectations (passed as `groundTruth`) for how each turn should be handled, the way a
 * curated eval dataset asserts a grader stays calibrated. Run over a committed labeled
 * dataset via `runEvals` — a green regression signal that never needs a model, unlike the
 * live prompt-alignment monitor which has no labels to check against.
 */
export const graderAgreementScorer = createScorer({
  id: GRADER_AGREEMENT_SCORER_ID,
  name: 'Grader Agreement',
  description:
    'Deterministic check that a grade agrees with a labeled transcript: senior floor/ceiling, skipped turns, dodges scored 1, and no turn scored twice.',
  type: 'agent',
})
  .preprocess(({ run }): AgreementInputs => {
    const expectation = transcriptExpectationSchema.safeParse(run.groundTruth);
    return {
      grade: extractGrade(run.output),
      expectation: expectation.success ? expectation.data : null,
    };
  })
  .generateScore(({ results }) => {
    const { grade, expectation } = results.preprocessStepResult;
    if (grade === null || expectation === null) return 0;
    return evaluateTranscriptAgreement(grade, expectation).value;
  })
  .generateReason(({ results }) => {
    const { grade, expectation } = results.preprocessStepResult;
    if (grade === null) return 'The grade could not be parsed into a session grade.';
    if (expectation === null) return 'No labeled expectations were provided to check the grade against.';
    const { violations } = evaluateTranscriptAgreement(grade, expectation);
    return violations.length === 0
      ? 'The grade agrees with the labels: floor, ceiling, skips, and dodges all respected.'
      : `The grade disagrees with the labels: ${violations.join('; ')}.`;
  });
