import { describe, expect, it } from 'vitest';

import { formatCandidateProfile, ingestCv, resolveIngestIds } from './run-interview';

describe('formatCandidateProfile', () => {
  it('renders the profile fields in a readable summary', () => {
    const out = formatCandidateProfile({
      name: 'Ada Lovelace',
      headline: 'Staff Engineer',
      yearsExperience: 8,
      roles: [{ title: 'Staff Engineer', company: 'Analytical Engines' }],
      projects: [{ name: 'Note G', technologies: ['Bernoulli'] }],
      quantifiedClaims: ['Cut batch runtime by 40%'],
      technologies: ['Rust', 'TypeScript'],
    });

    expect(out).toContain('Ada Lovelace');
    expect(out).toContain('Staff Engineer');
    expect(out).toContain('Analytical Engines');
    expect(out).toContain('Cut batch runtime by 40%');
    expect(out).toContain('Rust');
  });

  it('states plainly when a profile has no fields', () => {
    const out = formatCandidateProfile({
      roles: [],
      projects: [],
      quantifiedClaims: [],
      technologies: [],
    });

    expect(out).toContain('No profile fields');
  });
});

describe('resolveIngestIds', () => {
  it('gives each run a distinct candidate id when none is supplied', () => {
    const first = resolveIngestIds({});
    const second = resolveIngestIds({});

    expect(first.resourceId).not.toBe(second.resourceId);
    expect(first.threadId).not.toBe(second.threadId);
  });

  it('honours an explicit candidate and session id', () => {
    const ids = resolveIngestIds({ resourceId: 'candidate-x', threadId: 'session-x' });

    expect(ids).toEqual({ resourceId: 'candidate-x', threadId: 'session-x' });
  });
});

describe('ingestCv', () => {
  it('surfaces the underlying cause when the run fails', async () => {
    // An unsupported file type fails inside the ingest step before any model call,
    // so this exercises the real failure path offline.
    await expect(ingestCv({ cvPath: 'no-such-cv.docx' })).rejects.toThrow(/unsupported/i);
  });
});
