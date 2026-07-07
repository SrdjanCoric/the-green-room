import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';

import { createWorkflowStateReader } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';

import {
  asInterviewSuspend,
  readSuspendPayload,
} from '../mastra/workflows/interview-workflow';

/**
 * Accumulate a multi-line answer: read lines until the `/done` sentinel (or end of
 * input), then join and trim them. Pure over an injected line source, so the sentinel
 * logic is testable without a real terminal.
 */
export async function collectAnswer(
  nextLine: () => Promise<string | null>,
  sentinel = '/done',
): Promise<string> {
  const lines: string[] = [];
  for (;;) {
    const line = await nextLine();
    if (line === null || line === sentinel) break;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

/** Read one multi-line answer from a stream, ending on a `/done` line or EOF. */
export async function readMultilineAnswer(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
  const rl = createInterface({ input, output });
  const iterator = rl[Symbol.asyncIterator]();
  try {
    return await collectAnswer(async () => {
      const next = await iterator.next();
      return next.done ? null : String(next.value);
    });
  } finally {
    rl.close();
  }
}

/** A pointer to the most recent interview run, so `resume` can reconnect to it. */
export interface LastRun {
  runId: string;
  resourceId: string;
  threadId: string;
}

/** Default location of the last-run pointer: under the gitignored `data/` directory. */
export function defaultLastRunPath(): string {
  return join(process.cwd(), 'data', 'last-run.json');
}

/** Persist the latest run pointer so an interrupted interview can be resumed by `runId`. */
export async function saveLastRun(info: LastRun, path = defaultLastRunPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(info, null, 2), 'utf8');
}

/** Load the latest run pointer, or `null` if none has been saved. */
export async function loadLastRun(path = defaultLastRunPath()): Promise<LastRun | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as LastRun).runId === 'string'
    ) {
      return parsed as LastRun;
    }
    return null;
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
 * resume, until the run is no longer suspended. Transport-agnostic — the CLI injects
 * terminal prompts; a test injects scripted answers.
 */
export async function driveInterview(params: DriveInterviewParams): Promise<DriveResult> {
  let result = params.initial;
  while (result.status === 'suspended') {
    const payload = readSuspendPayload(result.suspendPayload);
    if (!payload) {
      throw new Error('The interview suspended without a recognizable prompt.');
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
}

export interface RunInterviewParams {
  workflow: InterviewWorkflowHandle;
  inputData: unknown;
  requestContext?: RequestContext;
  resourceId: string;
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
  await saveLastRun(
    { runId: run.runId, resourceId: params.resourceId, threadId: params.threadId },
    params.lastRunPath,
  );

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
  // Seed the driver with the pending suspension so it prompts before the first resume.
  const initial: DriveResult = { status: 'suspended', suspendPayload: { pending: payload } };
  const result = await driveInterview({
    initial,
    resume: (resumeData) => run.resume({ resumeData, requestContext: params.requestContext }),
    onLevel: params.onLevel,
    onQuestion: params.onQuestion,
  });
  return { kind: 'resumed', result };
}

/**
 * Turn a non-successful drive result into a human message, or `null` when the run
 * actually succeeded. The workflow serializes step errors through storage, so a
 * failure arrives as a plain `{ message }` object rather than an `Error` instance.
 */
export function describeDriveFailure(result: DriveResult): string | null {
  if (result.status === 'success') return null;
  const error = result.error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return `Interview run ended with status: ${result.status}`;
}
