import { describe, expect, it } from 'vitest';

import { directorDecisionSchema } from './director-decision';

describe('directorDecisionSchema', () => {
  it('accepts a follow_up decision with a subject and reason', () => {
    const parsed = directorDecisionSchema.parse({
      action: 'follow_up',
      subject: 'the 40% latency cut on the checkout service',
      reason: 'The number is stated but the how is missing.',
    });

    expect(parsed.action).toBe('follow_up');
    expect(parsed.subject).toContain('latency');
  });

  it('defaults subject and reason to empty strings for a wrap_up', () => {
    const parsed = directorDecisionSchema.parse({ action: 'wrap_up' });

    expect(parsed.action).toBe('wrap_up');
    expect(parsed.subject).toBe('');
    expect(parsed.reason).toBe('');
  });

  it('rejects an action outside the five allowed moves', () => {
    const result = directorDecisionSchema.safeParse({ action: 'improvise' });

    expect(result.success).toBe(false);
  });
});
