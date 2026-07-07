import type {
  AnswerAdvice,
  CoachReport,
  Drill,
  InterviewEvent,
  InterviewReport,
  SuspendPayload,
  TranscriptEntry,
} from './types';

/**
 * The authoritative end-of-stream state, in either of the two shapes Mastra hands
 * back: a terminal stream `WorkflowResult` (top-level `suspendPayload`/`result`) or a
 * `runById` `WorkflowState` (per-step `suspendPayload`). Only the fields this reader
 * needs are declared; everything else is ignored.
 */
export interface WorkflowOutcome {
  status?: string;
  suspendPayload?: unknown;
  steps?: Record<string, { status?: string; suspendPayload?: unknown } | undefined>;
  result?: unknown;
  error?: unknown;
}

/**
 * Normalise a finished/suspended run into the domain event the interview screen
 * acts on. Returns `null` while the run is still executing (running/waiting/pending),
 * so the caller keeps streaming. This is the single source of truth for the question,
 * the level prompt, and the final report — the live stream only decorates it.
 */
export function readOutcome(outcome: WorkflowOutcome | undefined): InterviewEvent | null {
  if (!outcome) return null;

  switch (outcome.status) {
    case 'suspended': {
      const suspend = readSuspend(outcome);
      return suspend ? { type: 'suspended', suspend } : null;
    }
    case 'success': {
      const report = readReport(outcome.result);
      return report ? { type: 'completed', report } : null;
    }
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

  if (payload.kind === 'level' && typeof payload.prompt === 'string') {
    return { kind: 'level', prompt: payload.prompt };
  }
  if (payload.kind === 'question' && typeof payload.question === 'string') {
    return {
      kind: 'question',
      question: payload.question,
      questionNumber: typeof payload.questionNumber === 'number' ? payload.questionNumber : 1,
    };
  }
  return null;
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
    const payload = asRecord(step?.suspendPayload);
    if (payload && typeof payload.kind === 'string') return payload;
  }
  return undefined;
}

function readReport(result: unknown): InterviewReport | null {
  const r = asRecord(result);
  const coaching = asRecord(r?.coaching);
  if (!r || !coaching) return null;

  const report: InterviewReport = {
    coaching: {
      summary: asString(coaching.summary),
      answerAdvice: asAnswerAdvice(coaching.answerAdvice),
      drills: asDrills(coaching.drills),
      studyPlan: asString(coaching.studyPlan),
    } satisfies CoachReport,
    transcript: asTranscript(r.transcript),
  };
  if (typeof r.targetLevel === 'string') report.targetLevel = r.targetLevel;
  if (typeof r.reportPath === 'string') report.reportPath = r.reportPath;

  const role = asRecord(r.role);
  if (role) {
    if (typeof role.role === 'string' && role.role) report.role = role.role;
    if (typeof role.company === 'string' && role.company) report.company = role.company;
  }
  return report;
}

function asAnswerAdvice(value: unknown): AnswerAdvice[] {
  return asArray(value).map((item) => {
    const a = asRecord(item);
    return { question: asString(a?.question), diagnosis: asString(a?.diagnosis), fix: asString(a?.fix) };
  });
}

function asDrills(value: unknown): Drill[] {
  return asArray(value).map((item) => {
    const d = asRecord(item);
    return { focus: asString(d?.focus), exercise: asString(d?.exercise) };
  });
}

function asTranscript(value: unknown): TranscriptEntry[] {
  return asArray(value).map((item) => {
    const t = asRecord(item);
    return { question: asString(t?.question), answer: asString(t?.answer) };
  });
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
