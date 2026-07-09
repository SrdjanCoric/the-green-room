import { safeSetItem } from './storage';

/** The "Previously staged" storage key. */
export const HISTORY_KEY = 'green-room:history';

const STATUSES: ReadonlySet<string> = new Set(['live', 'done', 'failed']);

/** One past or in-progress interview shown in the sidebar. */
export interface RunHistoryEntry {
  runId: string;
  role?: string;
  company?: string;
  level?: string;
  /** ISO timestamp the run was started. */
  startedAt: string;
  /** `failed` means the run settled in an error — reopening it retries the reconnect. */
  status: 'live' | 'done' | 'failed';
}

/**
 * Read the interview history, tolerating an absent or corrupt store. Each entry is
 * shape-checked rather than blindly cast, so a truncated write or an old schema drops
 * the bad entries instead of hydrating the sidebar with ill-formed rows.
 */
export function loadHistory(storage: Storage): RunHistoryEntry[] {
  const raw = storage.getItem(HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRunHistoryEntry) : [];
  } catch {
    return [];
  }
}

function isRunHistoryEntry(value: unknown): value is RunHistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.runId === 'string' &&
    typeof record.startedAt === 'string' &&
    typeof record.status === 'string' &&
    STATUSES.has(record.status)
  );
}

/** Persist the interview history, guarding against a full-quota write. */
export function saveHistory(storage: Storage, entries: RunHistoryEntry[]): void {
  safeSetItem(storage, HISTORY_KEY, JSON.stringify(entries));
}

/**
 * Insert or update an entry by `runId`. A new run goes to the front; an existing one
 * is updated in place (so finishing a run doesn't reorder the list).
 */
export function upsertEntry(entries: RunHistoryEntry[], entry: RunHistoryEntry): RunHistoryEntry[] {
  const index = entries.findIndex((e) => e.runId === entry.runId);
  if (index === -1) return [entry, ...entries];
  const next = entries.slice();
  next[index] = { ...next[index], ...entry };
  return next;
}

/**
 * Patch an existing entry by `runId`, leaving its other fields (notably `startedAt`)
 * intact. A no-op when the run isn't in the list, so the caller can update freely.
 */
export function updateEntry(
  entries: RunHistoryEntry[],
  runId: string,
  patch: Partial<RunHistoryEntry>,
): RunHistoryEntry[] {
  const index = entries.findIndex((e) => e.runId === runId);
  const current = index === -1 ? undefined : entries[index];
  if (!current) return entries;
  const next = entries.slice();
  next[index] = { ...current, ...patch };
  return next;
}
