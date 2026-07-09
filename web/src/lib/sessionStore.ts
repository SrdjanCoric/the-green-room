import type { InterviewPhase, InterviewState } from './interviewMachine';
import { safeSetItem } from './storage';

/**
 * Per-run interview-state snapshots, keyed by run id. The reducer state is persisted
 * at phase transitions so a reloaded page can restore the settled transcript before
 * it rejoins the run's live stream; the in-flight section is rebuilt from the
 * observed stream's replay, not from here.
 */
const SESSION_PREFIX = 'green-room:session:';

const PHASES: ReadonlySet<string> = new Set<InterviewPhase>([
  'idle',
  'starting',
  'streamingQuestion',
  'awaitingAnswer',
  'awaitingLevel',
  'assessing',
  'closing',
  'grading',
  'report',
  'turnFailed',
  'error',
]);

/** Persist the interview state for a run. */
export function saveSession(storage: Storage, runId: string, state: InterviewState): void {
  safeSetItem(storage, `${SESSION_PREFIX}${runId}`, JSON.stringify(state));
}

/**
 * Read a run's saved interview state. An absent, corrupt, or wrong-shape snapshot
 * (a truncated write, an old schema) returns `null`, so the caller falls back to a
 * cold reconnect instead of hydrating undefined fields into the reducer.
 */
export function loadSession(storage: Storage, runId: string): InterviewState | null {
  const raw = storage.getItem(`${SESSION_PREFIX}${runId}`);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isInterviewState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Drop a run's saved interview state (the run finished or was abandoned). */
export function clearSession(storage: Storage, runId: string): void {
  storage.removeItem(`${SESSION_PREFIX}${runId}`);
}

function isInterviewState(value: unknown): value is InterviewState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.phase === 'string' &&
    PHASES.has(record.phase) &&
    Array.isArray(record.transcript) &&
    typeof record.currentQuestion === 'string'
  );
}

/**
 * Client-side bookkeeping for one run's stream, persisted so it survives a reload.
 */
export interface RunMeta {
  /**
   * How many stream chunks this browser has received for the run over the caching
   * transports (`stream`/`resumeStream`), which is exactly how many chunks the
   * server has cached for it. An observe after a reload passes this as the replay
   * offset, so the rejoined stream skips everything already seen.
   */
  offset: number;
  /** The model-tier overrides the run was started with, re-supplied on every resume. */
  requestContext?: Record<string, string>;
  /**
   * Armed while a resume is in flight: run-state writes at or before this time are
   * the pre-resume suspend (the very question just answered), not an outcome. An
   * observe after a mid-turn reload uses it as the staleness floor so it waits for
   * the turn's real result instead of re-presenting the answered question. Disarmed
   * once a stream settles.
   */
  staleAsOf?: number;
}

const META_PREFIX = 'green-room:run-meta:';

/** Persist the run's stream bookkeeping. */
export function saveRunMeta(storage: Storage, runId: string, meta: RunMeta): void {
  safeSetItem(storage, `${META_PREFIX}${runId}`, JSON.stringify(meta));
}

/** Read the run's stream bookkeeping; a missing or corrupt record means a fresh start. */
export function loadRunMeta(storage: Storage, runId: string): RunMeta {
  const raw = storage.getItem(`${META_PREFIX}${runId}`);
  if (!raw) return { offset: 0 };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { offset: 0 };
    const record = parsed as Record<string, unknown>;
    const meta: RunMeta = {
      offset:
        typeof record.offset === 'number' && Number.isInteger(record.offset) && record.offset >= 0
          ? record.offset
          : 0,
    };
    if (isStringRecord(record.requestContext)) meta.requestContext = record.requestContext;
    if (typeof record.staleAsOf === 'number') meta.staleAsOf = record.staleAsOf;
    return meta;
  } catch {
    return { offset: 0 };
  }
}

/** Drop the run's stream bookkeeping. */
export function clearRunMeta(storage: Storage, runId: string): void {
  storage.removeItem(`${META_PREFIX}${runId}`);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}
