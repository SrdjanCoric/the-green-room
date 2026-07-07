import type { fetch as undiciFetch } from 'undici';
import { describe, expect, it, vi } from 'vitest';

import { fetchPostingText, type FetchPostingOptions } from './fetch-posting';
import { UnsafePostingUrlError } from './safe-fetch';

/** A lookup that always resolves to one global address. */
const globalLookup = async () => ['93.184.216.34'];

/** A fetch that must never be called — proves the SSRF guard short-circuits before any request. */
const forbiddenFetch: typeof undiciFetch = () => {
  throw new Error('fetch should not have been called');
};

/** Build a fetch that returns a canned Response for each URL it sees, in order per URL. */
function fetchReturning(handler: (url: string) => Response): typeof undiciFetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url);
  }) as unknown as typeof undiciFetch;
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const LD_JSON_PAGE = `<html><head>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org/',
  '@type': 'JobPosting',
  title: 'Senior Platform Engineer',
  hiringOrganization: { '@type': 'Organization', name: 'Globex' },
  employmentType: 'FULL_TIME',
  description: '<p>Build and run our <b>platform</b>.</p><ul><li>On-call rotation</li></ul>',
})}</script>
</head><body><p>ignored chrome</p></body></html>`;

describe('fetchPostingText — SSRF guard', () => {
  const base: FetchPostingOptions = { fetchImpl: forbiddenFetch, lookup: globalLookup };

  it('refuses a non-http(s) scheme', async () => {
    await expect(fetchPostingText('file:///etc/passwd', base)).rejects.toBeInstanceOf(
      UnsafePostingUrlError,
    );
  });

  it('refuses localhost', async () => {
    await expect(fetchPostingText('http://localhost:8080/jobs', base)).rejects.toBeInstanceOf(
      UnsafePostingUrlError,
    );
  });

  it('refuses IP literals in loopback / private / link-local ranges', async () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://10.0.0.5/job',
      'http://192.168.0.10/job',
      'http://169.254.169.254/latest/meta-data', // cloud metadata endpoint
      'http://[::1]/job',
    ]) {
      await expect(fetchPostingText(url, base)).rejects.toBeInstanceOf(UnsafePostingUrlError);
    }
  });

  it('refuses IPv4-mapped IPv6 literals that resolve to internal addresses', async () => {
    for (const url of [
      'http://[::ffff:7f00:1]/', // -> 127.0.0.1
      'http://[::ffff:a9fe:a9fe]/latest/meta-data', // -> 169.254.169.254
      'http://[0:0:0:0:0:ffff:10.0.0.1]/', // -> 10.0.0.1
    ]) {
      await expect(fetchPostingText(url, base)).rejects.toBeInstanceOf(UnsafePostingUrlError);
    }
  });

  it('refuses a hostname that resolves to a private address', async () => {
    await expect(
      fetchPostingText('https://internal.example.com/job', {
        fetchImpl: forbiddenFetch,
        lookup: async () => ['10.1.2.3'],
      }),
    ).rejects.toBeInstanceOf(UnsafePostingUrlError);
  });

  it('re-checks every redirect hop and refuses a redirect to a private address', async () => {
    const fetchImpl = fetchReturning((url) => {
      if (url.startsWith('https://jobs.example.com')) {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    await expect(
      fetchPostingText('https://jobs.example.com/role', { fetchImpl, lookup: globalLookup }),
    ).rejects.toBeInstanceOf(UnsafePostingUrlError);
  });
});

describe('fetchPostingText — extraction', () => {
  it('leaves an out-of-range numeric HTML entity untouched instead of crashing', async () => {
    const page = '<html><body><p>Comp &#x110000; and &#9999999; pay</p></body></html>';
    const result = await fetchPostingText('https://jobs.example.com/role', {
      fetchImpl: fetchReturning(() => html(page)),
      lookup: globalLookup,
    });

    expect(result.text).toContain('Comp');
    expect(result.text).toContain('pay');
    // The out-of-range entities are left verbatim rather than decoded (or crashing).
    expect(result.text).toContain('&#x110000;');
    expect(result.text).toContain('&#9999999;');
  });

  it('prefers a JobPosting ld+json block over page chrome', async () => {
    const result = await fetchPostingText('https://jobs.example.com/role', {
      fetchImpl: fetchReturning(() => html(LD_JSON_PAGE)),
      lookup: globalLookup,
    });

    expect(result.source).toBe('ld+json');
    expect(result.text).toContain('Role: Senior Platform Engineer');
    expect(result.text).toContain('Company: Globex');
    expect(result.text).toContain('Build and run our platform');
    expect(result.text).toContain('On-call rotation');
    expect(result.text).not.toContain('ignored chrome');
  });

  it('falls back to visible text when there is no ld+json', async () => {
    const page = '<html><body><h1>Widget Wrangler</h1><p>We need someone great.</p></body></html>';
    const result = await fetchPostingText('https://jobs.example.com/role', {
      fetchImpl: fetchReturning(() => html(page)),
      lookup: globalLookup,
    });

    expect(result.source).toBe('html');
    expect(result.text).toContain('Widget Wrangler');
    expect(result.text).toContain('We need someone great.');
  });

  it('follows a same-host redirect and reports the final URL', async () => {
    const fetchImpl = fetchReturning((url) => {
      if (url.endsWith('/role')) {
        return new Response(null, { status: 301, headers: { location: '/role/final' } });
      }
      return html(LD_JSON_PAGE);
    });

    const result = await fetchPostingText('https://jobs.example.com/role', {
      fetchImpl,
      lookup: globalLookup,
    });

    expect(result.url).toBe('https://jobs.example.com/role/final');
    expect(result.text).toContain('Senior Platform Engineer');
  });

  it('truncates the extracted text to the character cap', async () => {
    const result = await fetchPostingText('https://jobs.example.com/role', {
      fetchImpl: fetchReturning(() => html(LD_JSON_PAGE)),
      lookup: globalLookup,
      maxChars: 8,
    });

    expect(result.text).toHaveLength(8);
  });

  it('aborts when the body exceeds the byte cap', async () => {
    const big = html('a'.repeat(5000));
    await expect(
      fetchPostingText('https://jobs.example.com/role', {
        fetchImpl: fetchReturning(() => big),
        lookup: globalLookup,
        maxBytes: 100,
      }),
    ).rejects.toThrow(/size cap/i);
  });
});

describe('fetchPostingText — Workable special case', () => {
  it('hits the widget JSON API and selects the job matching the shortcode', async () => {
    const fetchSpy = vi.fn(
      fetchReturning((url) => {
        expect(url).toBe('https://apply.workable.com/api/v1/widget/accounts/acme?details=true');
        return json({
          jobs: [
            { shortcode: 'ZZZ000', title: 'Unrelated Role' },
            {
              shortcode: 'ABC123',
              title: 'Data Scientist',
              company: 'Acme',
              description: '<p>Do data things.</p>',
            },
          ],
        });
      }),
    );

    const result = await fetchPostingText('https://apply.workable.com/acme/j/ABC123/', {
      fetchImpl: fetchSpy as unknown as typeof undiciFetch,
      lookup: globalLookup,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.source).toBe('workable');
    expect(result.text).toContain('Role: Data Scientist');
    expect(result.text).toContain('Company: Acme');
    expect(result.text).toContain('Do data things.');
    expect(result.text).not.toContain('Unrelated Role');
  });

  it('throws rather than returning a different job when the shortcode is absent', async () => {
    await expect(
      fetchPostingText('https://apply.workable.com/acme/j/MISSING1/', {
        fetchImpl: fetchReturning(() => json({ jobs: [{ shortcode: 'OTHER99', title: 'Other' }] })),
        lookup: globalLookup,
      }),
    ).rejects.toThrow(/not.*found/i);
  });
});
