import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createWorkflowStateReader } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';

import { dataDir } from '../data-dir';
import { describeError } from '../errors';
import {
  asInterviewSuspend,
  readSuspendPayload,
} from '../workflows/interview-state';
import { REPLAYABLE_STEPS, type ReplayableStepName } from '../workflows/interview-workflow';

/** A pointer to the most recent interview run, so `resume` can reconnect to it. */
const lastRunSchema = z.object({
  runId: z.string(),
  threadId: z.string(),
});

export type LastRun = z.infer<typeof lastRunSchema>;

/** Default location of the last-run pointer: beside the database under the
 *  project-root `data/` directory, so every entrypoint resumes the same run. */
export function defaultLastRunPath(): string {
  return join(dataDir, 'last-run.json');
}

/** Persist the latest run pointer so an interrupted interview can be resumed by `runId`. */
export async function saveLastRun(info: LastRun, path = defaultLastRunPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(info, null, 2), 'utf8');
}

/** Load the latest run pointer, or `null` if none has been saved (or it is malformed). */
export async function loadLastRun(path = defaultLastRunPath()): Promise<LastRun | null> {
  try {
    const parsed = lastRunSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The slice of a workflow result the interview driver reads. */
export interface DriveResult {
  status: string;
  suspendPayload?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export interface DriveInterviewParams {
  /** The current (already-started or already-reconnected) run result. */
  initial: DriveResult;
  /** Resume the run with the given payload and return the next result. */
  resume: (resumeData: Record<string, unknown>) => Promise<DriveResult>;
  /** Prompt the operator for the target level, given the workflow's prompt text. */
  onLevel: (prompt: string) => Promise<string>;
  /** Prompt the candidate for an answer to a question. */
  onQuestion: (question: string, questionNumber: number) => Promise<string>;
}

/**
 * Drive a suspended interview run to completion: each suspension is either a request
 * for the target level or a question, so answer it via the matching callback and
 * resume, until the run is no longer suspended. A `failure` suspension ends the drive
 * instead — the run stays suspended (the transcript safe in its snapshot) and the
 * caller reports it, so the operator retries with the `resume` command rather than
 * this loop hammering a failing provider. Transport-agnostic — the CLI injects
 * terminal prompts; a test injects scripted answers.
 */
export async function driveInterview(params: DriveInterviewParams): Promise<DriveResult> {
  let result = params.initial;
  while (result.status === 'suspended') {
    const payload = readSuspendPayload(result.suspendPayload);
    if (!payload) {
      throw new Error('The interview suspended without a recognizable prompt.');
    }
    if (payload.kind === 'failure') {
      return result;
    }
    if (payload.kind === 'level') {
      const level = await params.onLevel(payload.prompt);
      result = await params.resume({ level });
    } else {
      const answer = await params.onQuestion(payload.question, payload.questionNumber);
      result = await params.resume({ answer });
    }
  }
  return result;
}

/** The minimal workflow surface the interview runners depend on. */
export interface InterviewWorkflowHandle {
  createRun(options?: { runId?: string }): Promise<InterviewRunHandle>;
  getWorkflowRunById(runId: string): Promise<unknown | null>;
}

export interface InterviewRunHandle {
  runId: string;
  start(args: { inputData: unknown; requestContext?: RequestContext }): Promise<DriveResult>;
  resume(args: { resumeData: unknown; requestContext?: RequestContext }): Promise<DriveResult>;
  /**
   * Re-run the workflow from a given step, reconstructing every earlier step from the
   * persisted snapshot rather than executing it. Backs `regrade`/`recoach`: re-running
   * the grading phase without re-asking a single interview question.
   */
  timeTravel(args: { step: string; requestContext?: RequestContext }): Promise<DriveResult>;
}

export interface RunInterviewParams {
  workflow: InterviewWorkflowHandle;
  inputData: unknown;
  requestContext?: RequestContext;
  threadId: string;
  onLevel: (prompt: string) => Promise<string>;
  onQuestion: (question: string, questionNumber: number) => Promise<string>;
  /** Called once preparation (ingest/research) is done and the run first suspends,
   *  just before any interactive prompt — lets the caller clear a "preparing" spinner. */
  onReady?: () => void;
  lastRunPath?: string;
}

/**
 * Start a fresh interview run and drive it to completion, persisting the run pointer
 * up front so the session can be resumed if it is interrupted. Returns the final
 * result and the `runId`.
 */
export async function runInterview(
  params: RunInterviewParams,
): Promise<{ runId: string; result: DriveResult }> {
  const run = await params.workflow.createRun();
  await saveLastRun({ runId: run.runId, threadId: params.threadId }, params.lastRunPath);

  const started = await run.start({
    inputData: params.inputData,
    requestContext: params.requestContext,
  });
  // Signal readiness only when preparation actually suspended for input — so the
  // caller can stop a progress spinner before the first prompt. A run that instead
  // failed during preparation is left for the caller to report as a failure.
  if (started.status === 'suspended') params.onReady?.();
  const result = await driveInterview({
    initial: started,
    resume: (resumeData) => run.resume({ resumeData, requestContext: params.requestContext }),
    onLevel: params.onLevel,
    onQuestion: params.onQuestion,
  });

  return { runId: run.runId, result };
}

export interface ReconnectInterviewParams {
  workflow: InterviewWorkflowHandle;
  runId: string;
  requestContext?: RequestContext;
  onLevel: (prompt: string) => Promise<string>;
  onQuestion: (question: string, questionNumber: number) => Promise<string>;
}

/**
 * The outcome of a reconnect attempt: no such run, a run that had already finished
 * (so there was nothing to resume), or a run that was suspended and has now been
 * driven to completion. Distinguishing these lets the CLI say "nothing to resume"
 * instead of re-reporting a finished interview as though it had just resumed.
 */
export type ReconnectOutcome =
  | { kind: 'not-found' }
  | { kind: 'already-finished'; result: DriveResult }
  | { kind: 'resumed'; result: DriveResult };

/**
 * Reconnect to a suspended run by `runId` and drive it to completion. Reads the
 * pending suspend payload from storage first (so the very next prompt shows the
 * question the candidate stopped on), then rehydrates the run and resumes.
 */
export async function reconnectInterview(
  params: ReconnectInterviewParams,
): Promise<ReconnectOutcome> {
  const state = await params.workflow.getWorkflowRunById(params.runId);
  if (!state) return { kind: 'not-found' };

  const reader = createWorkflowStateReader(state as Parameters<typeof createWorkflowStateReader>[0]);
  const status = reader.getStatus();
  if (status !== 'suspended') {
    // Already terminal (success/failed/canceled): there is nothing to resume.
    return { kind: 'already-finished', result: { status, result: reader.getResult() } };
  }

  const pending = reader.getSuspendedStep();
  const payload = asInterviewSuspend(pending?.suspendPayload);
  if (!payload) {
    throw new Error('The suspended run is not waiting on a recognizable interview prompt.');
  }

  const run = await params.workflow.createRun({ runId: params.runId });
  const resume = (resumeData: Record<string, unknown>) =>
    run.resume({ resumeData, requestContext: params.requestContext });

  // A run that suspended on a failed turn is retried exactly once — this resume *is*
  // the retry. If the turn fails again the driver stops on the fresh failure payload
  // rather than hammering a failing provider in a loop.
  const initial: DriveResult =
    payload.kind === 'failure'
      ? await resume({ retry: true })
      : // Seed the driver with the pending suspension so it prompts before the first resume.
        { status: 'suspended', suspendPayload: { pending: payload } };
  const result = await driveInterview({
    initial,
    resume,
    onLevel: params.onLevel,
    onQuestion: params.onQuestion,
  });
  return { kind: 'resumed', result };
}

export interface ReplaySessionParams {
  workflow: InterviewWorkflowHandle;
  runId: string;
  requestContext?: RequestContext;
}

/**
 * The outcome of a regrade/recoach attempt: no such run; a run still mid-interview
 * (nothing to grade yet); a terminal run that never produced the step's input, so there
 * is nothing to replay from; or a run re-run from the grading phase to a fresh report.
 */
export type ReplayOutcome =
  | { kind: 'not-found' }
  | { kind: 'unfinished' }
  | { kind: 'not-replayable' }
  | { kind: 'replayed'; result: DriveResult };

/**
 * Re-run a finished interview from a grading-phase step, reusing the stored transcript
 * and executing no interview turns. `grade` re-runs grade → coach → report; `coach`
 * re-runs coach → report, reconstructing the earlier grade from the snapshot. Rehydrates
 * the run by `runId` and time-travels from that step, so nothing before it is re-executed.
 *
 * A replay only makes sense once the step it starts from has a stored input: `grade`
 * reconstructs its transcript from `closing`, and `coach` reconstructs its grade from
 * `grade`. A run that is still mid-interview, or one that failed before reaching that
 * prerequisite, has no such snapshot — so we report it rather than time-travelling into a
 * missing state and surfacing an opaque error or a report graded off nothing.
 */
async function replaySession(
  params: ReplaySessionParams,
  stepName: ReplayableStepName,
): Promise<ReplayOutcome> {
  const state = await params.workflow.getWorkflowRunById(params.runId);
  if (!state) return { kind: 'not-found' };

  const reader = createWorkflowStateReader(state as Parameters<typeof createWorkflowStateReader>[0]);
  if (reader.getStatus() === 'suspended') {
    // The interview is still mid-session: there is no finished transcript to grade yet.
    return { kind: 'unfinished' };
  }

  // Step ids and prerequisites come from the workflow's own replayable-step table,
  // derived from the step objects — never hardcoded strings that could drift.
  const { step, prerequisite } = REPLAYABLE_STEPS[stepName];
  if (reader.getStepOutput(prerequisite) === undefined) {
    // Terminal, but the step we'd replay from never produced its input (e.g. the run
    // failed before `closing`, or before `grade` for a recoach) — nothing to replay.
    return { kind: 'not-replayable' };
  }

  const run = await params.workflow.createRun({ runId: params.runId });
  const result = await run.timeTravel({ step, requestContext: params.requestContext });
  return { kind: 'replayed', result };
}

/** Re-grade a finished session: re-run grade, coach, and report from the stored transcript. */
export function regradeSession(params: ReplaySessionParams): Promise<ReplayOutcome> {
  return replaySession(params, 'grade');
}

/** Re-coach a finished session: re-run coach and report only, reusing the stored grade. */
export function recoachSession(params: ReplaySessionParams): Promise<ReplayOutcome> {
  return replaySession(params, 'coach');
}

/**
 * Turn a non-successful drive result into a human message, or `null` when the run
 * actually succeeded. A run left suspended on a failed turn renders the failure
 * payload — what broke and that the transcript is safe — pointing the operator at
 * the `resume` command, which retries the turn. The workflow serializes step errors
 * through storage, so a hard failure arrives as a plain `{ message }` object rather
 * than an `Error` instance.
 */
export function describeDriveFailure(result: DriveResult): string | null {
  if (result.status === 'success') return null;
  if (result.status === 'suspended') {
    const payload = readSuspendPayload(result.suspendPayload);
    if (payload?.kind === 'failure') {
      return (
        `${payload.reason} The interview is paused with your answers saved — ` +
        'run the resume command to retry this turn.'
      );
    }
  }
  if (result.error !== undefined) return describeError(result.error);
  return `Interview run ended with status: ${result.status}`;
}
