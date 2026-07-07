import { isIP, type LookupFunction } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from 'undici';

/**
 * Shared transport plumbing for every outbound fetch in the app: the SSRF guard, the
 * manual redirect loop that re-checks each hop, connection pinning against DNS
 * rebinding, the streaming byte cap, and surrogate-safe truncation. Content policy
 * (what to make of the bytes) stays with the callers.
 */

/** Overall time budget for a fetch, across every redirect hop and the body read. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Resolve a hostname to its IP addresses. Injectable so SSRF tests stay hermetic. */
export type HostLookup = (hostname: string) => Promise<string[]>;

export const defaultLookup: HostLookup = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true });
  return results.map((result) => result.address);
};

/** Raised when a URL (or a redirect target) points somewhere we refuse to fetch. */
export class UnsafePostingUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePostingUrlError';
  }
}

export interface SafeFetchOptions {
  /** Byte cap enforced while streaming the body. */
  maxBytes: number;
  /** How many redirect hops to follow before giving up. Each hop is re-checked for SSRF. */
  maxRedirects: number;
  /** Overall time budget in ms; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injected `fetch`, defaulting to undici's. When set, IP pinning is skipped (the mock controls resolution). */
  fetchImpl?: typeof undiciFetch;
  /** Injected DNS resolver, defaulting to `dns/promises` lookup. */
  lookup?: HostLookup;
  signal?: AbortSignal;
  /** `Accept` header to send. */
  accept: string;
  /** Names the resource in error messages, e.g. "Posting" or "Research page". */
  resourceLabel: string;
}

export interface SafeFetchResult {
  /** The full response body, read under the byte cap. */
  body: string;
  /** The final URL fetched, after any redirects. */
  url: string;
  /** The final response's content type, empty when absent. */
  contentType: string;
}

/**
 * Fetch a URL's body as text with the full transport guard: refuses non-http(s)
 * schemes, hostless URLs, localhost, and any address that resolves to a non-global
 * range (loopback, private, link-local, unique-local) — re-checked on every redirect
 * hop, so a redirect can't smuggle the request onto an internal host — and caps the
 * download while streaming.
 */
export async function safeFetchText(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const lookup = options.lookup ?? defaultLookup;
  const usingRealFetch = options.fetchImpl === undefined;
  const fetchImpl = options.fetchImpl ?? undiciFetch;

  // One overall time budget across every redirect hop and the body read, so a slow or
  // hanging upstream can't stall the call indefinitely.
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  let currentUrl = rawUrl;
  for (let hop = 0; ; hop++) {
    const target = await resolveSafeTarget(currentUrl, lookup);

    // Pin the connection to the exact IP we validated so the real fetch can't
    // re-resolve the hostname to a different (internal) address between the check and
    // the connect — the DNS-rebinding window. Skipped when a fetchImpl is injected,
    // since the mock already controls resolution.
    const dispatcher =
      usingRealFetch && target.pinnedAddress ? pinnedDispatcher(target.pinnedAddress) : undefined;

    try {
      // Undici's own fetch types know the `dispatcher` init option, so pinning needs no cast.
      const response = await fetchImpl(target.url.toString(), {
        redirect: 'manual',
        signal,
        headers: { accept: options.accept },
        ...(dispatcher ? { dispatcher } : {}),
      });

      if (isRedirectStatus(response.status)) {
        // Drain the redirect body so the connection is free — an unconsumed body keeps
        // the request in flight and would stall the dispatcher teardown below.
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Redirect from ${currentUrl} had no Location header.`);
        }
        if (hop >= options.maxRedirects) {
          throw new Error(`Too many redirects (> ${options.maxRedirects}) starting from ${rawUrl}.`);
        }
        // Resolve a relative redirect against the current URL; the next loop iteration
        // re-runs the SSRF check (and re-pins) on the resolved target.
        currentUrl = new URL(location, target.url).toString();
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Fetching ${currentUrl} failed with status ${response.status}.`);
      }

      const body = await readBodyCapped(response, options.maxBytes, options.resourceLabel);
      return { body, url: currentUrl, contentType: response.headers.get('content-type') ?? '' };
    } finally {
      // `destroy()` tears the per-hop dispatcher down immediately regardless of body
      // state, so it can never hang the way `close()` (which awaits in-flight requests) can.
      await dispatcher?.destroy();
    }
  }
}

/** Build an undici dispatcher whose connector only ever resolves to the pre-validated IP. */
export function pinnedDispatcher(address: string): Agent {
  const family = isIP(address) === 6 ? 6 : 4;
  const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (typeof lookupOptions === 'object' && lookupOptions?.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
  return new Agent({ connect: { lookup } });
}

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Read a response body as UTF-8 text, enforcing the byte cap while streaming. */
export async function readBodyCapped(
  response: UndiciResponse,
  maxBytes: number,
  resourceLabel: string,
): Promise<string> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new Error(`${resourceLabel} exceeds the ${maxBytes}-byte size cap.`);
    }
    return text;
  }
  // undici types its body stream as ReadableStream<any>; the chunks are Uint8Array.
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`${resourceLabel} exceeds the ${maxBytes}-byte size cap.`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Truncate text to a character cap without leaving a split surrogate pair. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const lastCode = sliced.charCodeAt(sliced.length - 1);
  // Drop a lone high surrogate (0xD800–0xDBFF) so the result stays valid UTF-16.
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

// --- SSRF guard ------------------------------------------------------------

/** A URL cleared for fetching, plus the IP to pin the connection to (null for an IP literal). */
export interface SafeTarget {
  url: URL;
  pinnedAddress: string | null;
}

/**
 * Validate a URL for fetching and, for a hostname, resolve it to a single global IP
 * to pin the connection to. Refuses non-http(s) schemes, hostless URLs, localhost,
 * and any address in a non-global range. Returning the validated IP lets the caller
 * connect to exactly what was checked, closing the DNS-rebinding window.
 */
export async function resolveSafeTarget(rawUrl: string, lookup: HostLookup): Promise<SafeTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafePostingUrlError(`Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafePostingUrlError(`Only http(s) URLs are allowed, got "${url.protocol}".`);
  }

  // `URL.hostname` keeps the brackets around an IPv6 literal; strip them so
  // `isIP` recognises the address.
  const rawHost = url.hostname;
  const hostname =
    rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  if (!hostname) {
    throw new UnsafePostingUrlError(`URL has no host: ${rawUrl}`);
  }

  // An IP literal: check it directly. Connecting to a literal never re-resolves, so
  // there is nothing to pin.
  if (isIP(hostname)) {
    if (!isGlobalIp(hostname)) {
      throw new UnsafePostingUrlError(`Refusing to fetch a non-global address: ${hostname}`);
    }
    return { url, pinnedAddress: null };
  }

  const lowered = hostname.toLowerCase();
  if (lowered === 'localhost' || lowered.endsWith('.localhost')) {
    throw new UnsafePostingUrlError(`Refusing to fetch localhost: ${hostname}`);
  }

  // A DNS name: resolve it, require every address to be global, then pin the first so
  // the socket connects to exactly what we checked.
  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new UnsafePostingUrlError(`Could not resolve host: ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new UnsafePostingUrlError(`Host did not resolve to any address: ${hostname}`);
  }
  for (const address of addresses) {
    if (!isGlobalIp(address)) {
      throw new UnsafePostingUrlError(
        `Host ${hostname} resolves to a non-global address (${address}); refusing to fetch.`,
      );
    }
  }
  return { url, pinnedAddress: addresses[0] ?? null };
}

/** True for a publicly-routable IP; false for loopback/private/link-local/reserved. */
export function isGlobalIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isGlobalIpv4(ip);
  if (kind === 6) return isGlobalIpv6(ip);
  return false;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function isGlobalIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  const inRange = (base: string, bits: number): boolean => {
    const baseInt = ipv4ToInt(base);
    if (baseInt === null) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (baseInt & mask);
  };
  // Every range the IETF marks as non-global.
  return !(
    inRange('0.0.0.0', 8) || // "this" network / unspecified
    inRange('10.0.0.0', 8) || // private
    inRange('100.64.0.0', 10) || // carrier-grade NAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local
    inRange('172.16.0.0', 12) || // private
    inRange('192.0.0.0', 24) || // IETF protocol assignments
    inRange('192.0.2.0', 24) || // TEST-NET-1
    inRange('192.168.0.0', 16) || // private
    inRange('198.18.0.0', 15) || // benchmarking
    inRange('198.51.100.0', 24) || // TEST-NET-2
    inRange('203.0.113.0', 24) || // TEST-NET-3
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // reserved / broadcast
  );
}

function isGlobalIpv6(ip: string): boolean {
  const hextets = ipv6Hextets(ip);
  // A form we can't confidently classify is treated as unsafe (default-deny).
  if (!hextets) return false;

  // Any IPv4 embedded in IPv6 (mapped ::ffff:x/96, compatible ::x/96 incl. ::1/::,
  // or NAT64 64:ff9b::/96) is only as global as its embedded v4 — check that,
  // regardless of whether it was written in hex or dotted-quad form.
  const embedded = embeddedIpv4(hextets);
  if (embedded !== null) return isGlobalIpv4(intToIpv4(embedded));

  const first = hextets[0] ?? 0;
  const second = hextets[1] ?? 0;
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((first & 0xffc0) === 0xfec0) return false; // deprecated site-local fec0::/10
  if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((first & 0xff00) === 0xff00) return false; // multicast ff00::/8
  if (first === 0x0100 && hextets.slice(1, 4).every((part) => part === 0)) return false; // discard-only 100::/64
  if (first === 0x2001 && second >= 0x0000 && second <= 0x01ff) return false; // IETF special-purpose 2001::/23
  if (first === 0x2001 && second === 0x0db8) return false; // documentation 2001:db8::/32
  return true;
}

/** Expand a valid IPv6 address to exactly eight 16-bit groups, or null if unparseable. */
function ipv6Hextets(input: string): number[] | null {
  let addr = input.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone); // drop any zone id (fe80::1%eth0)

  // Fold a trailing IPv4 dotted-quad into two hex groups so the rest is pure hex.
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':');
    if (lastColon < 0) return null;
    const v4 = ipv4ToInt(addr.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const toGroups = (segment: string): number[] | null => {
    if (segment === '') return [];
    const out: number[] = [];
    for (const piece of segment.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };

  if (halves.length === 1) {
    const groups = toGroups(halves[0] ?? '');
    return groups?.length === 8 ? groups : null;
  }

  const head = toGroups(halves[0] ?? '');
  const tail = toGroups(halves[1] ?? '');
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null; // `::` must stand in for at least one zero group
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * The embedded IPv4 (as a 32-bit int) for any IPv6 form that carries one, else null.
 * Covers the transition/translation schemes that would otherwise let an IPv6 literal
 * smuggle a private/loopback v4 past the guard: IPv4-mapped, IPv4-compatible, NAT64,
 * 6to4, and Teredo. The caller then validates the embedded v4 with {@link isGlobalIpv4}.
 */
function embeddedIpv4(hextets: number[]): number | null {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = hextets;
  const low32 = ((g << 16) | h) >>> 0;
  const topFiveZero = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  if (topFiveZero && f === 0xffff) return low32; // IPv4-mapped ::ffff:0:0/96
  if (topFiveZero && f === 0) return low32; // IPv4-compatible ::/96 (covers ::1, ::)
  if (a === 0x0064 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return low32; // NAT64 64:ff9b::/96
  if (a === 0x2002) return ((b << 16) | c) >>> 0; // 6to4 2002:V4::/16 (v4 in bits 16-47)
  if (a === 0x2001 && b === 0x0000) return (0xffffffff ^ low32) >>> 0; // Teredo 2001:0::/32 (client v4, obfuscated)
  return null;
}

function intToIpv4(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}
