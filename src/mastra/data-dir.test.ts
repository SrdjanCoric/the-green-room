import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveDataDir } from './data-dir';

describe('resolveDataDir', () => {
  it('resolves to the single canonical data/ directory at the project root', () => {
    // `src/mastra/` sits two levels below the root when run via tsx.
    expect(resolveDataDir('/repo/src/mastra')).toBe('/repo/data');
  });

  it('resolves the same canonical path from the `mastra dev` bundle output', () => {
    // The build bundles to `.mastra/output/`, also two levels below the root, so both
    // entrypoints read and write the same last-run pointer and reports directory.
    expect(resolveDataDir('/repo/.mastra/output')).toBe('/repo/data');
  });

  it('never anchors data underneath src/, from either entrypoint', () => {
    for (const moduleDir of ['/repo/src/mastra', '/repo/.mastra/output']) {
      expect(resolveDataDir(moduleDir)).not.toContain('/src/');
    }
  });

  it('honors an explicit INTERVIEW_COACH_DATA_DIR override', () => {
    expect(resolveDataDir('/repo/src/mastra', '/var/coach-data')).toBe('/var/coach-data');
  });

  it('resolves a relative override against the working directory', () => {
    expect(resolveDataDir('/repo/src/mastra', 'coach-data')).toBe(
      resolve(process.cwd(), 'coach-data'),
    );
  });

  it('ignores an empty override and falls back to the canonical path', () => {
    expect(resolveDataDir('/repo/src/mastra', '')).toBe('/repo/data');
  });
});
