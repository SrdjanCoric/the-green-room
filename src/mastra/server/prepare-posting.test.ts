import { describe, expect, it, vi } from 'vitest';

import { preparePosting } from './prepare-posting';

describe('preparePosting', () => {
  it('treats pasted text literally without fetching or touching the filesystem', async () => {
    const fetchPosting = vi.fn(async () => ({ text: 'nope', url: 'x' }));

    const result = await preparePosting({
      job: '  Senior Backend Engineer at Ramp.  ',
      kind: 'paste',
      resolveOptions: { fetchPosting },
    });

    expect(result.postingText).toBe('Senior Backend Engineer at Ramp.');
    expect(result.researchUrls).toEqual([]);
    expect(result.postingFetchFailedUrl).toBeUndefined();
    expect(fetchPosting).not.toHaveBeenCalled();
  });

  it('resolves a link through the SSRF-guarded fetcher and records the final url', async () => {
    const fetchPosting = vi.fn(async () => ({
      text: 'Posting body.',
      url: 'https://jobs.example.com/staff?utm=1',
    }));

    const result = await preparePosting({
      job: 'https://jobs.example.com/staff',
      kind: 'link',
      resolveOptions: { fetchPosting },
    });

    expect(result.postingText).toBe('Posting body.');
    expect(result.researchUrls).toEqual(['https://jobs.example.com/staff?utm=1']);
    expect(result.postingFetchFailedUrl).toBeUndefined();
  });

  it('reports a failed link fetch as data instead of throwing', async () => {
    const fetchPosting = vi.fn(async () => {
      throw new Error('SSRF refused');
    });

    const result = await preparePosting({
      job: 'https://jobs.example.com/staff',
      kind: 'link',
      resolveOptions: { fetchPosting },
    });

    expect(result.postingText).toBeUndefined();
    expect(result.researchUrls).toEqual([]);
    expect(result.postingFetchFailedUrl).toBe('https://jobs.example.com/staff');
  });

  it('returns no posting when the job is empty, for a generic interview', async () => {
    const result = await preparePosting({ job: '   ', kind: 'paste' });

    expect(result.postingText).toBeUndefined();
    expect(result.researchUrls).toEqual([]);
  });

  it('treats a non-url link value as a failed fetch so the ui can offer paste', async () => {
    const fetchPosting = vi.fn(async () => ({ text: 'nope', url: 'x' }));

    const result = await preparePosting({
      job: 'not a url',
      kind: 'link',
      resolveOptions: { fetchPosting },
    });

    expect(result.postingText).toBeUndefined();
    expect(result.postingFetchFailedUrl).toBe('not a url');
    expect(fetchPosting).not.toHaveBeenCalled();
  });
});
