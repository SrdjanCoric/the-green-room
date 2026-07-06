import { describe, expect, it, vi } from 'vitest';

import {
  formatCandidateProfile,
  formatRoleContext,
  ingestCv,
  resolveIngestIds,
  resolveJobPosting,
} from './run-interview';

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

describe('formatRoleContext', () => {
  it('renders the role, weighted competencies, and values', () => {
    const out = formatRoleContext({
      company: 'Globex',
      role: 'Staff Engineer',
      seniority: 'staff',
      summary: 'Owns the platform.',
      competencies: [
        { name: 'Distributed systems', weight: 0.9 },
        { name: 'Mentorship', weight: 0.6 },
      ],
      valuesFramework: ['Ownership'],
    });

    expect(out).toContain('Staff Engineer @ Globex');
    expect(out).toContain('Distributed systems (0.90)');
    expect(out).toContain('Ownership');
  });
});

describe('resolveJobPosting', () => {
  it('returns undefined when no job argument is supplied', async () => {
    expect(await resolveJobPosting({})).toBeUndefined();
  });

  it('returns the resolved posting text for inline text', async () => {
    const text = await resolveJobPosting({
      job: 'Senior Designer at Initech.',
      resolveOptions: { fileExists: async () => false },
    });

    expect(text).toBe('Senior Designer at Initech.');
  });

  it('falls back to pasted text when a URL fetch fails', async () => {
    const onFetchFailure = vi.fn(async () => 'Pasted posting body.');

    const text = await resolveJobPosting({
      job: 'https://jobs.example.com/role',
      onFetchFailure,
      resolveOptions: {
        fetchPosting: async () => {
          throw new Error('boom');
        },
      },
    });

    expect(onFetchFailure).toHaveBeenCalledWith('https://jobs.example.com/role');
    expect(text).toBe('Pasted posting body.');
  });

  it('proceeds with a generic interview when the paste is declined', async () => {
    const text = await resolveJobPosting({
      job: 'https://jobs.example.com/role',
      onFetchFailure: async () => null,
      resolveOptions: {
        fetchPosting: async () => {
          throw new Error('boom');
        },
      },
    });

    expect(text).toBeUndefined();
  });
});

describe('ingestCv', () => {
  it('surfaces the underlying cause when the run fails', async () => {
    // An unsupported file type fails inside the ingest step before any model call,
    // so this exercises the real failure path offline.
    await expect(ingestCv({ cvPath: 'no-such-cv.docx' })).rejects.toThrow(/unsupported/i);
  });
});
