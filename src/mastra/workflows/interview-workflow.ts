import { createWorkflow } from '@mastra/core/workflows';
import type { WorkflowOptions } from '@mastra/core/workflows';

import { ingestInputSchema, reportedInterviewStateSchema } from './interview-state';
import { ingestStep } from './steps/ingest';
import { researchStep } from './steps/research';
import {
  closingStep,
  collectLevelStep,
  interviewLoopDone,
  interviewTurnStep,
} from './steps/interview-loop';
import { coachStep, gradeStep } from './steps/grade-coach';
import { reportStep } from './steps/report';

/**
 * The interview run's snapshot-persistence policy: persist when the loop suspends (so
 * `resume` can reconnect), once `closing` succeeds (the pre-grade boundary that
 * grade/coach/report — and the `regrade`/`recoach` time-travel replays — re-run from),
 * and on a terminal failure, so a fault in the post-closing phase keeps the finished
 * transcript and its error durable to inspect and re-grade rather than losing it.
 *
 * Exported as the single source of truth for this contract: the durability of the
 * pre-grade boundary is exactly what time-travel depends on, so tests exercise this same
 * policy rather than a copy that could silently drift from what ships.
 */
export const interviewSnapshotPersistence: NonNullable<
  WorkflowOptions['shouldPersistSnapshot']
> = ({ stepResults, workflowStatus }) =>
  workflowStatus === 'suspended' ||
  workflowStatus === 'failed' ||
  workflowStatus === 'tripwire' ||
  stepResults[closingStep.id]?.status === 'success';

/**
 * The grading-phase steps a finished run can be replayed from via time-travel, with the
 * prerequisite step whose stored output each replay reconstructs its input from. Derived
 * from the step objects themselves so clients (the CLI's `regrade`/`recoach`) can never
 * drift from the workflow's actual step ids.
 */
export const REPLAYABLE_STEPS = {
  grade: { step: gradeStep.id, prerequisite: closingStep.id },
  coach: { step: coachStep.id, prerequisite: gradeStep.id },
} as const;

export type ReplayableStepName = keyof typeof REPLAYABLE_STEPS;

/**
 * The interview workflow. It ingests the CV and role, performs best-effort company
 * research, collects the target level, then runs the adaptive interview loop — each
 * turn suspending with a question and resuming with the answer — until the caps bound
 * the session. It then closes the interview and runs a separate grading/coaching/report
 * phase. It runs on a single durable run so the snapshot carries the whole session,
 * which is what lets the `resume` command reconnect by `runId`.
 */
export const interviewWorkflow = createWorkflow({
  id: 'interviewWorkflow',
  inputSchema: ingestInputSchema,
  outputSchema: reportedInterviewStateSchema,
  options: {
    shouldPersistSnapshot: interviewSnapshotPersistence,
  },
})
  .then(ingestStep)
  .then(researchStep)
  .then(collectLevelStep)
  .dountil(interviewTurnStep, interviewLoopDone)
  .then(closingStep)
  .then(gradeStep)
  .then(coachStep)
  .then(reportStep)
  .commit();
