import { extractPosting, type PostingSource } from './posting-extract';
import { safeFetchText, truncate, type HostLookup } from './safe-fetch';
import { parseWorkableJob, workableApiUrl } from './workable';

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

export interface FetchPostingResult {
  /** The extracted posting text, truncated to the character cap. */
  text: string;
  /** How the text was extracted. */
  source: PostingSource;
  /** The final URL fetched, after any redirects. */
  url: string;
}

export interface FetchPostingOptions {
  maxBytes?: number;
  maxChars?: number;
  maxRedirects?: number;
  /** Overall time budget in ms; defaults to the safe-fetch default. */
  timeoutMs?: number;
  /** Injected `fetch`, defaulting to undici's. When set, IP pinning is skipped (the mock controls resolution). */
  fetchImpl?: typeof fetch;
  /** Injected DNS resolver, defaulting to `dns/promises` lookup. */
  lookup?: HostLookup;
  signal?: AbortSignal;
}

/**
 * Fetch a job posting from an http(s) URL and return its text. The transport guard
 * (SSRF checks re-run on every redirect hop, connection pinning, streaming byte cap)
 * lives in the shared safe-fetch module; this function adds the posting-specific
 * content policy — prefer structured `JobPosting` data (ld+json or the Workable JSON
 * API) over raw page text, and truncate the result.
 */
export async function fetchPostingText(
  rawUrl: string,
  options: FetchPostingOptions = {},
): Promise<FetchPostingResult> {
  const maxChars = options.maxChars ?? MAX_POSTING_CHARS;

  // Workable renders postings client-side, so its hosted URLs carry little text.
  // Rewrite them to the public JSON widget endpoint before fetching.
  const workable = workableApiUrl(rawUrl);

  const { body, url, contentType } = await safeFetchText(workable?.apiUrl ?? rawUrl, {
    maxBytes: options.maxBytes ?? MAX_POSTING_BYTES,
    maxRedirects: options.maxRedirects ?? MAX_REDIRECTS,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    lookup: options.lookup,
    signal: options.signal,
    accept: 'text/html,application/json,application/ld+json;q=0.9,*/*;q=0.8',
    resourceLabel: 'Posting',
  });

  if (workable) {
    return {
      text: truncate(parseWorkableJob(body, workable.shortcode), maxChars),
      source: 'workable',
      url,
    };
  }

  const extracted = extractPosting(body, contentType);
  return { text: truncate(extracted.text, maxChars), source: extracted.source, url };
}

/** Truncate posting text to a character cap without leaving a split surrogate pair. */
export function capPostingText(text: string, maxChars: number = MAX_POSTING_CHARS): string {
  return truncate(text, maxChars);
}
