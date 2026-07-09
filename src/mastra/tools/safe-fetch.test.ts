import { describe, expect, it } from 'vitest';
import type { Response as UndiciResponse } from 'undici';

import { UnsafePostingUrlError, isGlobalIp, readBodyCapped, resolveSafeTarget } from './safe-fetch';

/** A lookup that always resolves to one global address. */
const globalLookup = async () => ['93.184.216.34'];

/**
 * A minimal response double exposing only what {@link readBodyCapped} reads: an optional
 * body stream, a `content-length` header, and `text()`. Typed through `unknown` because a
 * full undici `Response` is far larger than the three members under test.
 */
function responseDouble(opts: {
  body?: ReadableStream<Uint8Array> | null;
  contentLength?: string;
  text?: () => Promise<string>;
}): UndiciResponse {
  return {
    body: opts.body ?? null,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' ? (opts.contentLength ?? null) : null,
    },
    text: opts.text ?? (async () => ''),
  } as unknown as UndiciResponse;
}

/**
 * A single-chunk byte stream of `size` zero bytes; `onRead` fires when a chunk is pulled.
 * `highWaterMark: 0` keeps the stream from eagerly pulling to fill its queue at
 * construction, so `onRead` reflects an actual `read()` — the signal a test uses to prove
 * the body was never touched.
 */
function streamOfBytes(size: number, onRead?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        onRead?.();
        controller.enqueue(new Uint8Array(size));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

describe('isGlobalIp', () => {
  it('rejects loopback, private, link-local, and IPv6 local ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
    ]) {
      expect(isGlobalIp(ip)).toBe(false);
    }
  });

  it('rejects IPv4-mapped / embedded IPv6 forms that hide a private or loopback v4', () => {
    for (const ip of [
      '::ffff:7f00:1', // hex-form ::ffff:127.0.0.1 (loopback)
      '::ffff:a9fe:a9fe', // hex-form ::ffff:169.254.169.254 (metadata)
      '::ffff:0a00:0001', // hex-form ::ffff:10.0.0.1 (private)
      '0:0:0:0:0:ffff:10.0.0.1', // expanded IPv4-mapped
      '::ffff:192.168.1.1', // dotted IPv4-mapped
      '64:ff9b::a00:1', // NAT64 embedding 10.0.0.1
      '64:ff9b:1::7f00:1', // RFC 8215 local-use NAT64 (v4 position varies; whole /48 is non-global)
      '64:ff9b:1:ffff::203.0.113.9', // local-use NAT64, dotted form, high end of the /48
      '2002:7f00:1::', // 6to4 embedding 127.0.0.1
      '2002:a9fe:a9fe::', // 6to4 embedding 169.254.169.254
    ]) {
      expect(isGlobalIp(ip)).toBe(false);
    }
  });

  it('still accepts a 6to4 address that embeds a global v4', () => {
    expect(isGlobalIp('2002:5db8:d822::')).toBe(true); // 6to4 of 93.184.216.34
  });

  it('accepts publicly-routable addresses', () => {
    expect(isGlobalIp('93.184.216.34')).toBe(true);
    expect(isGlobalIp('8.8.8.8')).toBe(true);
    expect(isGlobalIp('2606:2800:220:1::1')).toBe(true);
  });
});

describe('resolveSafeTarget', () => {
  it('pins a hostname to its first validated global address', async () => {
    const target = await resolveSafeTarget('https://jobs.example.com/role', async () => [
      '93.184.216.34',
      '8.8.8.8',
    ]);
    expect(target.pinnedAddress).toBe('93.184.216.34');
  });

  it('does not pin an IP literal (nothing to re-resolve)', async () => {
    const target = await resolveSafeTarget('http://93.184.216.34/role', globalLookup);
    expect(target.pinnedAddress).toBeNull();
  });

  it('rejects a hostname resolving to a private address before any fetch', async () => {
    await expect(
      resolveSafeTarget('https://internal.example.com/role', async () => ['10.0.0.1']),
    ).rejects.toBeInstanceOf(UnsafePostingUrlError);
  });
});

describe('readBodyCapped size enforcement', () => {
  it('rejects an over-cap body declared by content-length without buffering it (no-body path)', async () => {
    // If the pre-check fails to fire, the no-body branch calls text() and this throws a
    // distinct error — so a passing size-cap rejection proves the body was never read.
    const response = responseDouble({
      body: null,
      contentLength: '1000',
      text: async () => {
        throw new Error('the body must not be buffered once content-length exceeds the cap');
      },
    });

    await expect(readBodyCapped(response, 100, 'The page')).rejects.toThrow(/100-byte size cap/);
  });

  it('rejects an over-cap body declared by content-length before reading the stream', async () => {
    let read = false;
    const body = streamOfBytes(1000, () => {
      read = true;
    });
    const response = responseDouble({ body, contentLength: '1000' });

    await expect(readBodyCapped(response, 100, 'The page')).rejects.toThrow(/100-byte size cap/);
    // The declared length rejected it before the first chunk was pulled.
    expect(read).toBe(false);
  });

  it('still caps an over-cap streamed body that declares no content-length', async () => {
    const response = responseDouble({ body: streamOfBytes(1000) });

    await expect(readBodyCapped(response, 100, 'The page')).rejects.toThrow(/100-byte size cap/);
  });

  it('returns a within-cap body on the no-body path', async () => {
    const response = responseDouble({ body: null, text: async () => 'a short page' });

    await expect(readBodyCapped(response, 100, 'The page')).resolves.toBe('a short page');
  });

  it('reads a streamed body whose content-length is within the cap', async () => {
    const response = responseDouble({ body: streamOfBytes(50), contentLength: '50' });

    const result = await readBodyCapped(response, 100, 'The page');
    // 50 zero bytes decode to 50 NUL characters — within the 100-byte cap.
    expect(result).toHaveLength(50);
  });
});
