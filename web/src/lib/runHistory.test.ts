import { describe, expect, it } from 'vitest';

import {
  HISTORY_KEY,
  loadHistory,
  type RunHistoryEntry,
  updateEntry,
  upsertEntry,
} from './runHistory';

function fakeStorage(initial?: Record<string, string>): Storage {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => map.delete(k),
    setItem: (k, v) => map.set(k, v),
  };
}

const entry: RunHistoryEntry = {
  runId: 'r1',
  role: 'Staff Engineer',
  company: 'Figma',
  level: 'staff',
  startedAt: '2026-07-06T10:00:00.000Z',
  status: 'live',
};

describe('run history store', () => {
  it('returns an empty list when nothing is stored', () => {
    expect(loadHistory(fakeStorage())).toEqual([]);
  });

  it('tolerates a corrupt stored value', () => {
    expect(loadHistory(fakeStorage({ [HISTORY_KEY]: 'not json' }))).toEqual([]);
  });

  it('adds a new entry at the front', () => {
    const next = upsertEntry([], entry);
    expect(next).toEqual([entry]);
  });

  it('replaces an existing entry by runId without duplicating, keeping it in place', () => {
    const older: RunHistoryEntry = { ...entry, runId: 'r0' };
    const list = [entry, older];

    const next = upsertEntry(list, { ...entry, status: 'done', role: 'Staff PE' });

    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ runId: 'r1', status: 'done', role: 'Staff PE' });
    expect(next[1]).toEqual(older);
  });

  it('patches an entry in place, preserving its start time', () => {
    const next = updateEntry([entry], 'r1', { status: 'done', role: 'Staff PE' });

    expect(next[0]).toMatchObject({ status: 'done', role: 'Staff PE' });
    expect(next[0].startedAt).toBe(entry.startedAt); // not clobbered
  });

  it('is a no-op when the runId is unknown', () => {
    const list = [entry];
    expect(updateEntry(list, 'missing', { status: 'done' })).toBe(list);
  });
});
