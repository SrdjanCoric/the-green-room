import { isIP, type LookupFunction } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

import { createTool } from '@mastra/core/tools';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';

/**
 * Upper bound on the number of bytes downloaded from a posting URL, enforced while
 * streaming so a hostile or accidentally huge response can't exhaust memory before
 * we notice its `content-length`.
 */
export const MAX_POSTING_BYTES = 2 * 1024 * 1024;

/** Upper bound on the extracted posting text; caps the size (and cost) of the model request. */
export const MAX_POSTING_CHARS = 50_000;

/** How many redirect hops to follow before giving up. Each hop is re-checked for SSRF. */
export const MAX_REDIRECTS = 5;

/** Overall time budget for a fetch, across every redirect hop and the body read. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** How the posting text was obtained, for observability and tests. */
export type PostingSource = 'ld+json' | 'workable' | 'html';

export interface FetchPostingResult {
  /** The extracted posting text, truncated to the character cap. */
  text: string;
  /** How the text was extracted. */
  source: PostingSource;
  /** The final URL fetched, after any redirects. */
  url: string;
}

/** Resolve a hostname to its IP addresses. Injectable so SSRF tests stay hermetic. */
export type HostLookup = (hostname: string) => Promise<string[]>;

export interface FetchPostingOptions {
  maxBytes?: number;
  maxChars?: number;
  maxRedirects?: number;
  /** Overall time budget in ms; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injected `fetch`, defaulting to undici's. When set, IP pinning is skipped (the mock controls resolution). */
  fetchImpl?: typeof fetch;
  /** Injected DNS resolver, defaulting to `dns/promises` lookup. */
  lookup?: HostLookup;
  signal?: AbortSignal;
}

/** Raised when a URL (or a redirect target) points somewhere we refuse to fetch. */
export class UnsafePostingUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePostingUrlError';
  }
}

const defaultLookup: HostLookup = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true });
  return results.map((result) => result.address);
};

/**
 * Fetch a job posting from an http(s) URL and return its text. Refuses non-http(s)
 * schemes, hostless URLs, localhost, and any address that resolves to a non-global
 * range (loopback, private, link-local, unique-local) — re-checked on every redirect
 * hop, so a redirect can't smuggle the request onto an internal host. The download
 * is size-capped while streaming, structured `JobPosting` data (ld+json or the
 * Workable JSON API) is preferred over raw page text, and the result is truncated.
 */
export async function fetchPostingText(
  rawUrl: string,
  options: FetchPostingOptions = {},
): Promise<FetchPostingResult> {
  const maxBytes = options.maxBytes ?? MAX_POSTING_BYTES;
  const maxChars = options.maxChars ?? MAX_POSTING_CHARS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const lookup = options.lookup ?? defaultLookup;
  const usingRealFetch = options.fetchImpl === undefined;
  const fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as typeof fetch);

  // One overall time budget across every redirect hop and the body read, so a slow or
  // hanging upstream can't stall the call indefinitely.
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  // Workable renders postings client-side, so its hosted URLs carry little text.
  // Rewrite them to the public JSON widget endpoint before fetching.
  const workable = workableApiUrl(rawUrl);
  let currentUrl = workable?.apiUrl ?? rawUrl;

  for (let hop = 0; ; hop++) {
    const target = await resolveSafeTarget(currentUrl, lookup);

    // Pin the connection to the exact IP we validated so the real fetch can't
    // re-resolve the hostname to a different (internal) address between the check and
    // the connect — the DNS-rebinding window. Skipped when a fetchImpl is injected,
    // since the mock already controls resolution.
    const dispatcher =
      usingRealFetch && target.pinnedAddress ? pinnedDispatcher(target.pinnedAddress) : undefined;

    try {
      const response = await fetchImpl(target.url.toString(), {
        redirect: 'manual',
        signal,
        headers: {
          accept: 'text/html,application/json,application/ld+json;q=0.9,*/*;q=0.8',
        },
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit & { dispatcher?: Agent });

      if (isRedirectStatus(response.status)) {
        // Drain the redirect body so the connection is free — an unconsumed body keeps
        // the request in flight and would stall the dispatcher teardown below.
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Redirect from ${currentUrl} had no Location header.`);
        }
        if (hop >= maxRedirects) {
          throw new Error(`Too many redirects (> ${maxRedirects}) starting from ${rawUrl}.`);
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

      const body = await readBodyCapped(response, maxBytes);

      if (workable) {
        return {
          text: truncate(parseWorkableJob(body, workable.shortcode), maxChars),
          source: 'workable',
          url: currentUrl,
        };
      }

      const contentType = response.headers.get('content-type') ?? '';
      const extracted = extractPosting(body, contentType);
      return { text: truncate(extracted.text, maxChars), source: extracted.source, url: currentUrl };
    } finally {
      // `destroy()` tears the per-hop dispatcher down immediately regardless of body
      // state, so it can never hang the way `close()` (which awaits in-flight requests) can.
      await dispatcher?.destroy();
    }
  }
}

/** Build an undici dispatcher whose connector only ever resolves to the pre-validated IP. */
function pinnedDispatcher(address: string): Agent {
  const family = isIP(address) === 6 ? 6 : 4;
  const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (typeof lookupOptions === 'object' && lookupOptions !== null && lookupOptions.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
  return new Agent({ connect: { lookup } });
}

/** Truncate posting text to a character cap without leaving a split surrogate pair. */
export function capPostingText(text: string, maxChars: number = MAX_POSTING_CHARS): string {
  return truncate(text, maxChars);
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
  return { url, pinnedAddress: addresses[0] };
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

  const first = hextets[0];
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((first & 0xff00) === 0xff00) return false; // multicast ff00::/8
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
    const groups = toGroups(halves[0]);
    return groups && groups.length === 8 ? groups : null;
  }

  const head = toGroups(halves[0]);
  const tail = toGroups(halves[1]);
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
  const [a, b, c, d, e, f, g, h] = hextets;
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

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// --- size-capped body reader ----------------------------------------------

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new Error(`Posting exceeds the ${maxBytes}-byte size cap.`);
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Posting exceeds the ${maxBytes}-byte size cap.`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

// --- extraction ------------------------------------------------------------

function extractPosting(body: string, contentType: string): { text: string; source: PostingSource } {
  // Some boards serve JobPosting JSON directly at the posting URL.
  if (contentType.includes('json')) {
    const fromJson = jobPostingFromJson(body);
    if (fromJson) return { text: fromJson, source: 'ld+json' };
  }
  const fromLdJson = extractLdJsonJobPosting(body);
  if (fromLdJson) return { text: fromLdJson, source: 'ld+json' };
  return { text: htmlToText(body), source: 'html' };
}

const LD_JSON_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function extractLdJsonJobPosting(html: string): string | null {
  for (const match of html.matchAll(LD_JSON_RE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    const posting = findJobPosting(parsed);
    if (posting) {
      const text = jobPostingToText(posting);
      if (text) return text;
    }
  }
  return null;
}

function jobPostingFromJson(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const posting = findJobPosting(parsed);
  return posting ? jobPostingToText(posting) : null;
}

/** Walk an ld+json value (object, array, or `@graph`) for the first `JobPosting`. */
function findJobPosting(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(node)) {
    const type = node['@type'];
    if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) {
      return node;
    }
    if ('@graph' in node) return findJobPosting(node['@graph']);
  }
  return null;
}

function jobPostingToText(posting: Record<string, unknown>): string {
  const lines: string[] = [];
  const title = asString(posting.title);
  if (title) lines.push(`Role: ${title}`);

  const org = posting.hiringOrganization;
  const orgName = typeof org === 'string' ? org : asString(isRecord(org) ? org.name : undefined);
  if (orgName) lines.push(`Company: ${orgName}`);

  const employmentType = asString(posting.employmentType);
  if (employmentType) lines.push(`Employment type: ${employmentType}`);

  const location = jobLocationText(posting.jobLocation);
  if (location) lines.push(`Location: ${location}`);

  const description = asString(posting.description);
  if (description) lines.push('', htmlToText(description));

  return lines.join('\n').trim();
}

function jobLocationText(location: unknown): string | undefined {
  const place = Array.isArray(location) ? location[0] : location;
  if (!isRecord(place)) return undefined;
  const address = place.address;
  if (typeof address === 'string') return address;
  if (isRecord(address)) {
    const parts = [address.addressLocality, address.addressRegion, address.addressCountry]
      .map((part) => asString(part))
      .filter((part): part is string => part !== undefined);
    if (parts.length > 0) return parts.join(', ');
  }
  return undefined;
}

// --- Workable public JSON widget -------------------------------------------

const WORKABLE_HOST_RE = /(^|\.)workable\.com$/i;

interface WorkableTarget {
  apiUrl: string;
  shortcode: string | null;
}

/**
 * Map a Workable-hosted posting URL to its public, unauthenticated JSON endpoint,
 * or return null if the URL isn't a Workable board. Hosted URLs take two shapes —
 * `apply.workable.com/<account>/j/<SHORTCODE>` and `<account>.workable.com/j|jobs/<SHORTCODE>`
 * — both served by the account widget endpoint; the shortcode narrows to one job.
 */
export function workableApiUrl(rawUrl: string): WorkableTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!WORKABLE_HOST_RE.test(url.hostname)) return null;

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  let account: string | null = null;
  let shortcode: string | null = null;

  if (host === 'apply.workable.com') {
    account = segments[0] ?? null;
    const jIndex = segments.indexOf('j');
    if (jIndex >= 0) shortcode = segments[jIndex + 1] ?? null;
  } else {
    account = host.slice(0, host.length - '.workable.com'.length) || null;
    const key = segments.includes('j') ? 'j' : segments.includes('jobs') ? 'jobs' : null;
    if (key) shortcode = segments[segments.indexOf(key) + 1] ?? null;
  }

  if (!account) return null;
  const apiUrl = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(
    account,
  )}?details=true`;
  return { apiUrl, shortcode };
}

function parseWorkableJob(body: string, shortcode: string | null): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Workable API did not return JSON.');
  }
  const jobs = extractWorkableJobs(parsed);
  if (jobs.length === 0) {
    throw new Error('Workable API returned no jobs.');
  }
  // With a shortcode, return that job or fail — never silently substitute a different
  // posting (a stale/closed shortcode would otherwise build the interview for the
  // wrong role). Without one, fall back to the first job.
  if (shortcode) {
    const match = jobs.find(
      (candidate) => asString(candidate.shortcode)?.toLowerCase() === shortcode.toLowerCase(),
    );
    if (!match) {
      throw new Error(`Workable job "${shortcode}" was not found among the account's published jobs.`);
    }
    return workableJobToText(match);
  }
  return workableJobToText(jobs[0]);
}

function extractWorkableJobs(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (isRecord(parsed) && Array.isArray(parsed.jobs)) return parsed.jobs.filter(isRecord);
  if (isRecord(parsed)) return [parsed];
  return [];
}

function workableJobToText(job: Record<string, unknown>): string {
  const lines: string[] = [];
  const title = asString(job.title);
  if (title) lines.push(`Role: ${title}`);

  const company = asString(job.company) ?? asString(isRecord(job.account) ? job.account.name : undefined);
  if (company) lines.push(`Company: ${company}`);

  const location = asString(job.location) ?? asString(job.city) ?? asString(job.country);
  if (location) lines.push(`Location: ${location}`);

  const body = [job.description, job.requirements, job.benefits]
    .map((part) => asString(part))
    .filter((part): part is string => part !== undefined);
  if (body.length > 0) lines.push('', htmlToText(body.join('\n\n')));

  return lines.join('\n').trim();
}

// --- helpers ---------------------------------------------------------------

/** Strip HTML to readable text: drop scripts/styles, turn block ends into newlines. */
export function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const withBreaks = withoutNoise
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    const lowered = entity.toLowerCase();
    if (lowered in NAMED_ENTITIES) return NAMED_ENTITIES[lowered];
    if (lowered.startsWith('#x')) {
      return fromCodePoint(Number.parseInt(entity.slice(2), 16), whole);
    }
    if (lowered.startsWith('#')) {
      return fromCodePoint(Number.parseInt(entity.slice(1), 10), whole);
    }
    return whole;
  });
}

/** `String.fromCodePoint`, but leaves an out-of-range code point (`> 0x10FFFF`) untouched. */
function fromCodePoint(code: number, fallback: string): string {
  // Out of the Unicode range throws RangeError; a malformed posting must not crash the run.
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const lastCode = sliced.charCodeAt(sliced.length - 1);
  // Drop a lone high surrogate (0xD800–0xDBFF) so the result stays valid UTF-16.
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * The `fetchPosting` tool: a thin Mastra wrapper over {@link fetchPostingText} so the
 * SSRF-guarded fetch is callable as a tool. The posting resolver calls it directly;
 * exposing it as a tool also lets an agent fetch a posting on demand later.
 */
export const fetchPostingTool = createTool({
  id: 'fetch-posting',
  description:
    'Fetch a job posting from an http(s) URL and return its text. Guards against SSRF (refuses localhost and non-global addresses, re-checked on every redirect), caps the download size, and prefers structured JobPosting data over raw page text.',
  inputSchema: z.object({
    url: z.string().describe('The http(s) URL of the job posting to fetch.'),
  }),
  outputSchema: z.object({
    text: z.string().describe('The extracted posting text.'),
    source: z.enum(['ld+json', 'workable', 'html']).describe('How the text was extracted.'),
    url: z.string().describe('The final URL fetched, after any redirects.'),
  }),
  execute: async (inputData, context) => {
    return fetchPostingText(inputData.url, { signal: context?.abortSignal });
  },
});
