import { describe, expect, it } from 'vitest';

import { resolveDbUrl } from './storage';

describe('resolveDbUrl', () => {
  it('anchors the database inside the shared data directory', () => {
    expect(resolveDbUrl('/repo/data')).toBe('file:/repo/data/mastra.db');
  });

  it('follows a relocated data directory (INTERVIEW_COACH_DATA_DIR)', () => {
    // The db has no anchor of its own: one data-dir override moves it together
    // with the reports, uploads, and the last-run pointer.
    expect(resolveDbUrl('/var/coach-data')).toBe('file:/var/coach-data/mastra.db');
  });

  it('honors an explicit INTERVIEW_COACH_DB_URL override', () => {
    expect(resolveDbUrl('/repo/data', ':memory:')).toBe(':memory:');
    expect(resolveDbUrl('/repo/data', 'file:/tmp/other.db')).toBe('file:/tmp/other.db');
  });

  it('ignores an empty override and falls back to the canonical path', () => {
    expect(resolveDbUrl('/repo/data', '')).toBe('file:/repo/data/mastra.db');
  });
});
