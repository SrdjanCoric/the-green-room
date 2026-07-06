import { createTool } from '@mastra/core/tools';
import { fetch as undiciFetch } from 'undici';
import { z } from 'zod';

import {
  DEFAULT_TIMEOUT_MS,
  htmlToText,
  pinnedDispatcher,
  resolveSafeTarget,
  type HostLookup,
} from './fetch-posting';

export const MAX_RESEARCH_PAGE_BYTES = 1 * 1024 * 1024;
export const MAX_RESEARCH_PAGE_CHARS = 12_000;
export const MAX_RESEARCH_REDIRECTS = 5;

export interface FetchResearchPageResult {
  text: string;
  url: string;
}

export interface FetchResearchPageOptions {
  maxBytes?: number;
  maxChars?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  lookup?: HostLookup;
  signal?: AbortSignal;
}

export class PromptInjectionPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptInjectionPageError';
  }
}

const defaultLookup: HostLookup = async (hostname) => {
  const { lookup } = await import('node:dns/promises');
  const results = await lookup(hostname, { all: true });
  return results.map((result) => result.address);
};

export async function fetchResearchPage(
  rawUrl: string,
  options: FetchResearchPageOptions = {},
): Promise<FetchResearchPageResult> {
  const lookup = options.lookup ?? defaultLookup;
  const usingRealFetch = options.fetchImpl === undefined;
  const fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
  const maxBytes = options.maxBytes ?? MAX_RESEARCH_PAGE_BYTES;
  const maxChars = options.maxChars ?? MAX_RESEARCH_PAGE_CHARS;
  const maxRedirects = options.maxRedirects ?? MAX_RESEARCH_REDIRECTS;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  let currentUrl = rawUrl;
  for (let hop = 0; ; hop++) {
    const target = await resolveSafeTarget(currentUrl, lookup);
    const dispatcher =
      usingRealFetch && target.pinnedAddress ? pinnedDispatcher(target.pinnedAddress) : undefined;

    try {
      const response = await fetchImpl(target.url.toString(), {
        redirect: 'manual',
        signal,
        headers: { accept: 'text/html,text/plain,application/xhtml+xml,*/*;q=0.8' },
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit & { dispatcher?: ReturnType<typeof pinnedDispatcher> });

      if (isRedirectStatus(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error(`Redirect from ${currentUrl} had no Location header.`);
        if (hop >= maxRedirects) {
          throw new Error(`Too many redirects (> ${maxRedirects}) starting from ${rawUrl}.`);
        }
        currentUrl = new URL(location, target.url).toString();
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Fetching ${currentUrl} failed with status ${response.status}.`);
      }

      const body = await readBodyCapped(response, maxBytes);
      const text = htmlToText(body);
      assertNoObviousPromptInjection(text);
      return { text: truncate(text, maxChars), url: currentUrl };
    } finally {
      await dispatcher?.destroy();
    }
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new Error(`Research page exceeds the ${maxBytes}-byte size cap.`);
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
        throw new Error(`Research page exceeds the ${maxBytes}-byte size cap.`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const lastCode = sliced.charCodeAt(sliced.length - 1);
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

const PROMPT_INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)\b/i,
  /\bdisregard\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)\b/i,
  /\bforget\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)\b/i,
  /\boverride\s+(the\s+)?(system|developer)\s+(message|prompt|instructions)\b/i,
  /\breveal\s+(the\s+)?(system|developer)\s+(message|prompt|instructions)\b/i,
  /\byou\s+are\s+now\s+(in\s+)?developer\s+mode\b/i,
  /\bexfiltrate\b/i,
];

export function assertNoObviousPromptInjection(text: string): void {
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      throw new PromptInjectionPageError('Research page appears to contain prompt-injection instructions.');
    }
  }
}

export const fetchResearchPageTool = createTool({
  id: 'fetch-research-page',
  description:
    'Fetch a public company research page from an http(s) URL. Refuses localhost and non-global addresses, re-checks redirects, caps page size, and returns readable text.',
  inputSchema: z.object({
    url: z.string().describe('The public http(s) URL to fetch for company research.'),
  }),
  outputSchema: z.object({
    text: z.string().describe('Readable text extracted from the page.'),
    url: z.string().describe('The final URL fetched, after any redirects.'),
  }),
  execute: async (inputData, context) => {
    return fetchResearchPage(inputData.url, { signal: context?.abortSignal });
  },
});
