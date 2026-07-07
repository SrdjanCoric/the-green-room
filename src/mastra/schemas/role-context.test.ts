import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROLE_CONTEXT,
  competencySchema,
  roleContextSchema,
} from './role-context';

describe('roleContextSchema', () => {
  it('accepts a full role context with integer-weighted competencies and a framework', () => {
    const parsed = roleContextSchema.parse({
      company: 'Analytical Engines',
      role: 'Staff Backend Engineer',
      seniority: 'staff',
      summary: 'Owns the compute platform end to end.',
      competencies: [
        { name: 'Distributed systems', weight: 5 },
        { name: 'Mentorship', weight: 3 },
      ],
      framework: 'Amazon Leadership Principles',
    });

    expect(parsed.company).toBe('Analytical Engines');
    expect(parsed.competencies[0]).toEqual({ name: 'Distributed systems', weight: 5 });
    expect(parsed.framework).toBe('Amazon Leadership Principles');
  });

  it('fills competencies with an empty default and leaves framework unset when omitted', () => {
    const parsed = roleContextSchema.parse({ role: 'Product Manager' });

    expect(parsed.competencies).toEqual([]);
    expect(parsed.framework).toBeUndefined();
  });

  it('rejects a role context with no role title', () => {
    const result = roleContextSchema.safeParse({ company: 'Acme' });

    expect(result.success).toBe(false);
  });

  it('accepts competency weights across the whole 1..5 integer scale', () => {
    for (const weight of [1, 2, 3, 4, 5]) {
      expect(competencySchema.safeParse({ name: 'Leadership', weight }).success).toBe(true);
    }
  });

  it('rejects a competency weight below 1 or above 5', () => {
    expect(competencySchema.safeParse({ name: 'Leadership', weight: 0 }).success).toBe(false);
    expect(competencySchema.safeParse({ name: 'Leadership', weight: 6 }).success).toBe(false);
  });

  it('rejects a fractional competency weight', () => {
    expect(competencySchema.safeParse({ name: 'Leadership', weight: 0.5 }).success).toBe(false);
  });

  it('rejects a framework passed as an array instead of a single string', () => {
    const result = roleContextSchema.safeParse({
      role: 'Engineer',
      framework: ['Bias for action', 'Ownership'],
    });

    expect(result.success).toBe(false);
  });
});

describe('DEFAULT_ROLE_CONTEXT', () => {
  it('is a valid role context with generic competencies weighted on the 1..5 integer scale', () => {
    expect(roleContextSchema.safeParse(DEFAULT_ROLE_CONTEXT).success).toBe(true);
    expect(DEFAULT_ROLE_CONTEXT.competencies.length).toBeGreaterThan(0);
    for (const competency of DEFAULT_ROLE_CONTEXT.competencies) {
      expect(Number.isInteger(competency.weight)).toBe(true);
      expect(competency.weight).toBeGreaterThanOrEqual(1);
      expect(competency.weight).toBeLessThanOrEqual(5);
    }
  });
});
