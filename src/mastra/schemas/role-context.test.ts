import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROLE_CONTEXT,
  competencySchema,
  roleContextSchema,
} from './role-context';

describe('roleContextSchema', () => {
  it('accepts a full role context with weighted competencies and values', () => {
    const parsed = roleContextSchema.parse({
      company: 'Analytical Engines',
      role: 'Staff Backend Engineer',
      seniority: 'staff',
      summary: 'Owns the compute platform end to end.',
      competencies: [
        { name: 'Distributed systems', weight: 0.9 },
        { name: 'Mentorship', weight: 0.6 },
      ],
      valuesFramework: ['Bias for action', 'Ownership'],
    });

    expect(parsed.company).toBe('Analytical Engines');
    expect(parsed.competencies[0]).toEqual({ name: 'Distributed systems', weight: 0.9 });
    expect(parsed.valuesFramework).toContain('Ownership');
  });

  it('fills competencies and valuesFramework with empty defaults when omitted', () => {
    const parsed = roleContextSchema.parse({ role: 'Product Manager' });

    expect(parsed.competencies).toEqual([]);
    expect(parsed.valuesFramework).toEqual([]);
  });

  it('rejects a role context with no role title', () => {
    const result = roleContextSchema.safeParse({ company: 'Acme' });

    expect(result.success).toBe(false);
  });

  it('rejects a competency weight outside the 0..1 range', () => {
    const result = competencySchema.safeParse({ name: 'Leadership', weight: 1.5 });

    expect(result.success).toBe(false);
  });
});

describe('DEFAULT_ROLE_CONTEXT', () => {
  it('is a valid role context with generic, equally-weighted competencies', () => {
    expect(roleContextSchema.safeParse(DEFAULT_ROLE_CONTEXT).success).toBe(true);
    expect(DEFAULT_ROLE_CONTEXT.competencies.length).toBeGreaterThan(0);
    for (const competency of DEFAULT_ROLE_CONTEXT.competencies) {
      expect(competency.weight).toBeGreaterThanOrEqual(0);
      expect(competency.weight).toBeLessThanOrEqual(1);
    }
  });
});
