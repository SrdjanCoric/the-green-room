import type { fetch as undiciFetch } from 'undici';
import { describe, expect, it } from 'vitest';

import { fetchResearchPage, type FetchResearchPageOptions } from './fetch-research-page';
import { UnsafePostingUrlError } from './safe-fetch';

const globalLookup = async () => ['93.184.216.34'];

const forbiddenFetch: typeof undiciFetch = () => {
  throw new Error('fetch should not have been called');
};

function fetchReturning(handler: (url: string) => Response): typeof undiciFetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url);
  }) as unknown as typeof undiciFetch;
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

describe('fetchResearchPage', () => {
  const base: FetchResearchPageOptions = { fetchImpl: forbiddenFetch, lookup: globalLookup };

  it('refuses localhost before making a request', async () => {
    await expect(fetchResearchPage('http://localhost/admin', base)).rejects.toBeInstanceOf(
      UnsafePostingUrlError,
    );
  });

  it('refuses non-global IPv6 ranges before making a request', async () => {
    for (const url of ['http://[fec0::1]/', 'http://[2001:db8::1]/', 'http://[100::1]/']) {
      await expect(fetchResearchPage(url, base)).rejects.toBeInstanceOf(UnsafePostingUrlError);
    }
  });

  it('re-checks redirect hops and refuses a redirect to an internal address', async () => {
    const fetchImpl = fetchReturning((url) => {
      if (url === 'https://example.com/about') {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    await expect(
      fetchResearchPage('https://example.com/about', { fetchImpl, lookup: globalLookup }),
    ).rejects.toBeInstanceOf(UnsafePostingUrlError);
  });

  it('caps the downloaded body size', async () => {
    await expect(
      fetchResearchPage('https://example.com/about', {
        fetchImpl: fetchReturning(() => html('a'.repeat(5000))),
        lookup: globalLookup,
        maxBytes: 100,
      }),
    ).rejects.toThrow(/size cap/i);
  });

  it('returns readable page text truncated to the character budget', async () => {
    const result = await fetchResearchPage('https://example.com/about', {
      fetchImpl: fetchReturning(() =>
        html('<html><body><h1>Globex</h1><script>ignore()</script><p>Builds platforms.</p></body></html>'),
      ),
      lookup: globalLookup,
      maxChars: 12,
    });

    expect(result.text).toBe('Globex\nBuild');
    expect(result.url).toBe('https://example.com/about');
  });

  it('returns a page that merely quotes injection-like phrases; content is not its job', async () => {
    // The tool guards transport (SSRF, redirects, size caps) only. Injection detection
    // belongs to the research agent's step-phase page guard, which can judge intent —
    // a security blog quoting "ignore all previous instructions" must not hard-fail here.
    const result = await fetchResearchPage('https://security-blog.example/about', {
      fetchImpl: fetchReturning(() =>
        html('<p>Attackers write "ignore all previous instructions" to hijack agents.</p>'),
      ),
      lookup: globalLookup,
    });

    expect(result.text).toContain('ignore all previous instructions');
  });
});
