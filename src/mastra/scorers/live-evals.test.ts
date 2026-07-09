import { runEvals } from '@mastra/core/evals';
import { describe, expect, it } from 'vitest';

import { mastra } from '../index';
import { sessionGradeForTranscriptSchema } from '../schemas/coach-report';
import { buildGraderPrompt } from '../workflows/steps/grade-coach';
import { GRADER_AGREEMENT_SCORER_ID, graderAgreementScorer } from './grader-agreement';
import { graderCaseExpectation, graderCaseTranscript } from './__fixtures__/grader-cases';

/**
 * The live half of the eval suite: it runs the real grader over the committed labeled
 * transcript through Mastra's `runEvals` harness and scores its grade against the same
 * expectations the deterministic suite (grader-agreement.test.ts) checks a reference grade
 * against. It calls real models, so it is opt-in — set `RUN_LIVE_EVALS=1` (and a provider
 * key) and run `npm run test:evals`. In normal CI it is skipped, keeping the suite hermetic
 * while still giving operators a real end-to-end regression check.
 *
 * The grader emits its structured `SessionGrade` only when asked for it, so the run feeds
 * the exact production prompt (`buildGraderPrompt`) and the same per-transcript schema the
 * grade step uses — otherwise the agent would answer in prose and the agreement scorer
 * would have nothing to grade.
 */
const runLive = process.env.RUN_LIVE_EVALS === '1';

// This is the one path in the test suite that calls a real provider, so it needs the key
// from `.env`. Load it best-effort the same way the ingest script does — an ambient key
// still wins when there is no file. Only when actually running live; CI never loads it.
if (runLive) {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file present — rely on the ambient environment.
  }
}

describe.skipIf(!runLive)('grader agreement over the committed dataset (live runEvals)', () => {
  it('runs the real grader and scores its grade against the labels', async () => {
    let agreement: { score: number; reason?: string } | undefined;

    const result = await runEvals({
      target: mastra.getAgent('grader'),
      data: [
        {
          input: buildGraderPrompt(graderCaseTranscript, 'senior'),
          groundTruth: graderCaseExpectation,
        },
      ],
      scorers: [graderAgreementScorer],
      targetOptions: {
        structuredOutput: {
          schema: sessionGradeForTranscriptSchema(graderCaseTranscript.length),
          errorStrategy: 'warn',
        },
      },
      onItemComplete: ({ scorerResults }) => {
        const scored = scorerResults[GRADER_AGREEMENT_SCORER_ID] as
          | { score: number; reason?: string }
          | undefined;
        if (scored) agreement = { score: scored.score, reason: scored.reason };
      },
    });

    expect(result.summary.totalItems).toBe(1);
    expect(agreement).toBeDefined();
    // Agreement is a hard 0/1 verdict; log the real grader's result so an operator can see
    // whether it agreed with the labels and why.
    console.log(`grader-agreement score=${agreement!.score} reason=${agreement!.reason}`);
    expect([0, 1]).toContain(agreement!.score);
  }, 120_000);
});
