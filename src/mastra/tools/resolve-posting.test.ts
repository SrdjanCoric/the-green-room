import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { PostingFetchError, resolvePosting } from './resolve-posting';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

describe('resolvePosting', () => {
  it('fetches an http(s) URL and returns its text tagged as a url', async () => {
    const fetchPosting = vi.fn(async () => ({
      text: 'Role: Backend Engineer',
      url: 'https://jobs.example.com/role/final',
    }));

    const resolved = await resolvePosting('https://jobs.example.com/role', { fetchPosting });

    expect(fetchPosting).toHaveBeenCalledWith('https://jobs.example.com/role', undefined);
    expect(resolved).toMatchObject({
      kind: 'url',
      text: 'Role: Backend Engineer',
      url: 'https://jobs.example.com/role/final',
    });
  });

  it('wraps a fetch failure in a PostingFetchError carrying the URL', async () => {
    const fetchPosting = vi.fn(async () => {
      throw new Error('network down');
    });

    const error = await resolvePosting('https://jobs.example.com/role', { fetchPosting }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PostingFetchError);
    expect((error as PostingFetchError).url).toBe('https://jobs.example.com/role');
    expect((error as PostingFetchError).cause).toBeInstanceOf(Error);
  });

  it('reads an existing file and tags it as a file', async () => {
    const resolved = await resolvePosting(join(fixtures, 'sample-posting.md'));

    expect(resolved.kind).toBe('file');
    expect(resolved.text).toContain('Staff Product Manager');
    expect(resolved.text).toContain('Globex');
  });

  it('treats a non-URL, non-file argument as inline pasted text', async () => {
    const resolved = await resolvePosting('Senior Designer at Initech. Owns the design system.', {
      // A file check that always says "no such file" keeps the test off the disk.
      fileExists: async () => false,
    });

    expect(resolved.kind).toBe('text');
    expect(resolved.text).toBe('Senior Designer at Initech. Owns the design system.');
  });
});
