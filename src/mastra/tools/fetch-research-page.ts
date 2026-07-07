import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { htmlToText } from './html-to-text';
import { safeFetchText, truncate, type HostLookup } from './safe-fetch';

export const MAX_RESEARCH_PAGE_BYTES = 1 * 1024 * 1024;
export const MAX_RESEARCH_PAGE_CHARS = 12_000;
export const MAX_RESEARCH_REDIRECTS = 5;

/**
 * The tool's own `id`, used when it dispatches a tool call. This is *not* the key the
 * research agent registers it under — see {@link RESEARCH_FETCH_TOOL_KEY}.
 */
export const RESEARCH_FETCH_TOOL_ID = 'fetch-research-page';

/**
 * The key the research agent registers this tool under (`tools: { [KEY]: … }`). The
 * `beforeToolCall` fetch-budget hook matches this name, the step-phase page guard
 * selects its tool results by it, and the research prompt refers to it. Registration,
 * hook, guard, and prompt all read this one constant so they cannot drift; a rename
 * here flows to every consumer at once.
 */
export const RESEARCH_FETCH_TOOL_KEY = 'fetchResearchPage';

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

/**
 * Fetch a public research page and return its readable text. This tool guards
 * transport only — SSRF, redirects, size and character caps, all via the shared
 * safe-fetch module. Injection detection over the fetched content is the research
 * agent's step-phase page guard (`createResearchPageGuard`), which judges intent
 * instead of pattern-matching phrases.
 */
export async function fetchResearchPage(
  rawUrl: string,
  options: FetchResearchPageOptions = {},
): Promise<FetchResearchPageResult> {
  const { body, url } = await safeFetchText(rawUrl, {
    maxBytes: options.maxBytes ?? MAX_RESEARCH_PAGE_BYTES,
    maxRedirects: options.maxRedirects ?? MAX_RESEARCH_REDIRECTS,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    lookup: options.lookup,
    signal: options.signal,
    accept: 'text/html,text/plain,application/xhtml+xml,*/*;q=0.8',
    resourceLabel: 'Research page',
  });

  return { text: truncate(htmlToText(body), options.maxChars ?? MAX_RESEARCH_PAGE_CHARS), url };
}

export const fetchResearchPageTool = createTool({
  id: RESEARCH_FETCH_TOOL_ID,
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
