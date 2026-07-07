import { describe, expect, it } from 'vitest';

import { resolveDbUrl } from './storage';

describe('resolveDbUrl', () => {
  it('resolves to the single canonical data/mastra.db at the project root', () => {
    // `src/mastra/` sits two levels below the root when run via tsx.
    expect(resolveDbUrl('/repo/src/mastra')).toBe('file:/repo/data/mastra.db');
  });

  it('resolves the same canonical path from the `mastra dev` bundle output', () => {
    // The build bundles to `.mastra/output/`, also two levels below the root, so both
    // entrypoints must land on the one shared database Studio and the CLI read.
    expect(resolveDbUrl('/repo/.mastra/output')).toBe('file:/repo/data/mastra.db');
  });

  it('never anchors the database underneath src/, from either entrypoint', () => {
    // The safety property behind the exact paths above: a DB under `src/mastra/public`
    // would be swept into the `mastra dev` bundle as a static asset. Assert it holds for
    // both real module locations — the tsx source dir and the bundle output dir.
    for (const moduleDir of ['/repo/src/mastra', '/repo/.mastra/output']) {
      expect(resolveDbUrl(moduleDir)).not.toContain('/src/');
    }
  });

  it('honors an explicit INTERVIEW_COACH_DB_URL override', () => {
    expect(resolveDbUrl('/repo/src/mastra', ':memory:')).toBe(':memory:');
    expect(resolveDbUrl('/repo/src/mastra', 'file:/tmp/other.db')).toBe('file:/tmp/other.db');
  });

  it('ignores an empty override and falls back to the canonical path', () => {
    expect(resolveDbUrl('/repo/src/mastra', '')).toBe('file:/repo/data/mastra.db');
  });
});
