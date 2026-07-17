import {
  interviewReportResultSchema,
  interviewSuspendWireSchema,
} from '../../../shared/wire-contract';

import type { InterviewEvent, InterviewReport, SuspendPayload } from './types';

/**
 * The authoritative end-of-stream state, in either of the two shapes Mastra hands
 * back: a terminal stream `WorkflowResult` (top-level `suspendPayload`/`result`) or a
 * `runById` `WorkflowState` (per-step `suspendPayload`). Only the fields this reader
 * needs are declared; everything else is ignored.
 */
export interface WorkflowOutcome {
  status?: string;
  /** Snapshot write time (server metadata) — lets a poll spot pre-resume state. */
  updatedAt?: string | Date;
  suspendPayload?: unknown;
  steps?: Record<string, { status?: string; suspendPayload?: unknown } | undefined>;
  result?: unknown;
  error?: unknown;
}

/**
 * Normalise a finished/suspended run into the domain event the interview screen
 * acts on. Returns `null` while the run is still executing (running/waiting/pending),
 * so the caller keeps streaming. This is the single source of truth for the question,
 * the level prompt, and the final report — the live stream only decorates it. Both the
 * suspend payload and the result are validated through the shared wire-contract schemas,
 * so a renamed backend field surfaces as a parse miss rather than a silent blank.
 */
export function readOutcome(outcome: WorkflowOutcome | undefined): InterviewEvent | null {
  if (!outcome) return null;

  switch (outcome.status) {
    case 'suspended': {
      const suspend = readSuspend(outcome);
      return suspend ? { type: 'suspended', suspend } : null;
    }
    case 'success':
      return readCompleted(outcome.result);
    case 'failed':
    case 'tripwire':
      return { type: 'failed', message: readErrorMessage(outcome.error) };
    default:
      return null;
  }
}

function readSuspend(outcome: WorkflowOutcome): SuspendPayload | null {
  const payload = extractKindPayload(outcome.suspendPayload) ?? findSuspendedStepPayload(outcome.steps);
  if (!payload) return null;

  // The backend payloads carry extra private fields (the director's move, the failed
  // stage); the shared wire schema narrows them to exactly what the screen consumes.
  const parsed = interviewSuspendWireSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/**
 * Extract a `{ kind, … }` suspend payload from `suspendPayload`, which is either the
 * payload itself or a map keyed by the suspended step id (the terminal stream-result
 * shape). Returns the first kind-bearing record found.
 */
function extractKindPayload(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.kind === 'string') return record;
  for (const nested of Object.values(record)) {
    const inner = asRecord(nested);
    if (inner && typeof inner.kind === 'string') return inner;
  }
  return undefined;
}

function findSuspendedStepPayload(
  steps: WorkflowOutcome['steps'],
): Record<string, unknown> | undefined {
  for (const step of Object.values(steps ?? {})) {
    // A completed step keeps its old suspendPayload in the run state, so only a step
    // that is currently suspended can speak for the run.
    if (step?.status !== 'suspended') continue;
    const payload = asRecord(step.suspendPayload);
    if (payload && typeof payload.kind === 'string') return payload;
  }
  return undefined;
}

function readCompleted(
  result: unknown,
): Extract<InterviewEvent, { type: 'completed' }> | null {
  const parsed = interviewReportResultSchema.safeParse(result);
  if (!parsed.success) return null;
  const data = parsed.data;

  const report: InterviewReport = { coaching: data.coaching, transcript: data.transcript };
  if (data.targetLevel !== undefined) report.targetLevel = data.targetLevel;
  if (data.reportPath !== undefined) report.reportPath = data.reportPath;
  // The role and company live under the result's `roleContext` field — the workflow
  // never surfaces a bare `role`. Flatten them onto the report the sidebar and screen
  // meta read.
  if (data.roleContext) {
    if (data.roleContext.role) report.role = data.roleContext.role;
    if (data.roleContext.company) report.company = data.roleContext.company;
  }
  return data.closingMessage === undefined
    ? { type: 'completed', report }
    : { type: 'completed', report, closingMessage: data.closingMessage };
}

function readErrorMessage(error: unknown): string {
  const e = asRecord(error);
  if (e && typeof e.message === 'string' && e.message) return e.message;
  if (typeof error === 'string' && error) return error;
  return 'The interview run failed.';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
