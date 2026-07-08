import { describe, expect, it } from 'vitest';

import { workableApiUrl } from './workable';

describe('workableApiUrl', () => {
  it('maps an apply.workable.com posting URL to the public widget endpoint', () => {
    const target = workableApiUrl('https://apply.workable.com/acme/j/ABC123/');
    expect(target).toEqual({
      apiUrl: 'https://apply.workable.com/api/v1/widget/accounts/acme?details=true',
      shortcode: 'ABC123',
    });
  });

  it('maps a subdomain board URL to the same account endpoint', () => {
    const target = workableApiUrl('https://acme.workable.com/jobs/XYZ789');
    expect(target?.apiUrl).toBe(
      'https://apply.workable.com/api/v1/widget/accounts/acme?details=true',
    );
    expect(target?.shortcode).toBe('XYZ789');
  });

  it('returns null for a non-Workable URL', () => {
    expect(workableApiUrl('https://boards.greenhouse.io/acme/jobs/123')).toBeNull();
  });
});
