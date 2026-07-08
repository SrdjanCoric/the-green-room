import type { InterviewState } from './interviewMachine';

/**
 * Per-run interview-state snapshots, keyed by run id. The reducer state is persisted
 * as the run progresses so a reloaded page can restore the settled transcript before
 * it rejoins the run's live stream; the in-flight section is rebuilt from the
 * observed stream's replay, not from here.
 */
const SESSION_PREFIX = 'green-room:session:';

/** Persist the interview state for a run. */
export function saveSession(storage: Storage, runId: string, state: InterviewState): void {
  storage.setItem(`${SESSION_PREFIX}${runId}`, JSON.stringify(state));
}

/** Read a run's saved interview state, tolerating an absent or corrupt snapshot. */
export function loadSession(storage: Storage, runId: string): InterviewState | null {
  const raw = storage.getItem(`${SESSION_PREFIX}${runId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as InterviewState) : null;
  } catch {
    return null;
  }
}

/** Drop a run's saved interview state (the run finished or was abandoned). */
export function clearSession(storage: Storage, runId: string): void {
  storage.removeItem(`${SESSION_PREFIX}${runId}`);
}

/**
 * How many stream chunks this browser has received for a run over the caching
 * transports (`stream`/`resumeStream`), which is exactly how many chunks the server
 * has cached for it. An observe after a reload passes this as the replay offset, so
 * the rejoined stream skips everything already seen.
 */
const OFFSET_PREFIX = 'green-room:stream-offset:';

/** Persist the run's received-chunk count. */
export function saveStreamOffset(storage: Storage, runId: string, count: number): void {
  storage.setItem(`${OFFSET_PREFIX}${runId}`, String(count));
}

/** Read the run's received-chunk count; a missing or corrupt value means 0. */
export function loadStreamOffset(storage: Storage, runId: string): number {
  const raw = storage.getItem(`${OFFSET_PREFIX}${runId}`);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Drop the run's received-chunk count. */
export function clearStreamOffset(storage: Storage, runId: string): void {
  storage.removeItem(`${OFFSET_PREFIX}${runId}`);
}
