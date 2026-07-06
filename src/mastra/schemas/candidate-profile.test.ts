import { describe, expect, it } from 'vitest';

import { candidateProfileSchema } from './candidate-profile';

describe('candidateProfileSchema', () => {
  it('accepts a full profile with roles, projects, claims, and technologies', () => {
    const parsed = candidateProfileSchema.parse({
      name: 'Ada Lovelace',
      headline: 'Staff Engineer',
      yearsExperience: 8,
      roles: [
        { title: 'Staff Engineer', company: 'Analytical Engines', summary: 'Led the compute team.' },
      ],
      projects: [
        { name: 'Note G', description: 'First published algorithm', technologies: ['Bernoulli'] },
      ],
      quantifiedClaims: ['Cut batch runtime by 40%'],
      technologies: ['TypeScript', 'Rust'],
    });

    expect(parsed.name).toBe('Ada Lovelace');
    expect(parsed.roles[0].title).toBe('Staff Engineer');
    expect(parsed.technologies).toContain('Rust');
  });

  it('fills array fields with empty defaults when a sparse profile is parsed', () => {
    const parsed = candidateProfileSchema.parse({});

    expect(parsed.roles).toEqual([]);
    expect(parsed.projects).toEqual([]);
    expect(parsed.quantifiedClaims).toEqual([]);
    expect(parsed.technologies).toEqual([]);
  });

  it('rejects a role that is missing its title', () => {
    const result = candidateProfileSchema.safeParse({
      roles: [{ company: 'Analytical Engines' }],
    });

    expect(result.success).toBe(false);
  });
});
