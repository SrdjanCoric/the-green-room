/** The "Previously staged" storage key. */
export const HISTORY_KEY = 'green-room:history';

/** One past or in-progress interview shown in the sidebar. */
export interface RunHistoryEntry {
  runId: string;
  role?: string;
  company?: string;
  level?: string;
  /** ISO timestamp the run was started. */
  startedAt: string;
  status: 'live' | 'done';
}

/** Read the interview history, tolerating an absent or corrupt store. */
export function loadHistory(storage: Storage): RunHistoryEntry[] {
  const raw = storage.getItem(HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RunHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

/** Persist the interview history. */
export function saveHistory(storage: Storage, entries: RunHistoryEntry[]): void {
  storage.setItem(HISTORY_KEY, JSON.stringify(entries));
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
  if (index === -1) return entries;
  const next = entries.slice();
  next[index] = { ...next[index], ...patch };
  return next;
}
