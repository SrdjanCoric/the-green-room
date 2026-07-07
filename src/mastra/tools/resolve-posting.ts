import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { TEXT_FILE_EXTENSIONS } from './extract-cv';
import {
  MAX_POSTING_CHARS,
  capPostingText,
  fetchPostingText,
  type FetchPostingOptions,
} from './fetch-posting';
import { htmlToText } from './html-to-text';

/** How a raw `--job` argument was interpreted. */
export type PostingKind = 'url' | 'file' | 'text';

export interface ResolvedPosting {
  /** The posting text, capped to the character limit. */
  text: string;
  /** How the argument was resolved. */
  kind: PostingKind;
  /** For a URL, the final URL fetched (after redirects). */
  url?: string;
}

const HTML_EXTENSIONS = new Set(['.html', '.htm']);

/** Upper bound on a posting file's size, checked before it is read. */
export const MAX_POSTING_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Raised when a posting URL could not be fetched (network error, SSRF refusal, bad
 * status). The CLI catches this to offer the paste fallback, so a broken link never
 * blocks the interview. Carries the URL that failed.
 */
export class PostingFetchError extends Error {
  readonly url: string;

  constructor(url: string, options?: { cause?: unknown }) {
    super(`Could not fetch the job posting at ${url}.`, options);
    this.name = 'PostingFetchError';
    this.url = url;
  }
}

export interface ResolvePostingOptions {
  /** Injected posting fetcher; defaults to the real {@link fetchPostingText}. */
  fetchPosting?: (
    url: string,
    options?: FetchPostingOptions,
  ) => Promise<{ text: string; url: string }>;
  /** Options forwarded to the fetcher (e.g. an abort signal). */
  fetchOptions?: FetchPostingOptions;
  /** Injected existence check; defaults to a filesystem `stat`. */
  fileExists?: (path: string) => Promise<boolean>;
  /** Injected file reader; defaults to {@link extractPostingFile}. */
  readPostingFile?: (path: string) => Promise<string>;
}

/**
 * Resolve a raw `--job` argument into posting text. An http(s) URL is fetched
 * (SSRF-guarded); an argument naming an existing file is read and extracted;
 * anything else is treated as the posting pasted inline. A URL that fails to fetch
 * raises {@link PostingFetchError} so the caller can fall back to a paste prompt.
 */
export async function resolvePosting(
  job: string,
  options: ResolvePostingOptions = {},
): Promise<ResolvedPosting> {
  const trimmed = job.trim();

  if (isHttpUrl(trimmed)) {
    const fetchPosting = options.fetchPosting ?? fetchPostingText;
    try {
      const result = await fetchPosting(trimmed, options.fetchOptions);
      return { text: capPostingText(result.text), kind: 'url', url: result.url };
    } catch (error) {
      throw new PostingFetchError(trimmed, { cause: error });
    }
  }

  const fileExists = options.fileExists ?? defaultFileExists;
  if (await fileExists(trimmed)) {
    const read = options.readPostingFile ?? extractPostingFile;
    return { text: capPostingText(await read(trimmed)), kind: 'file' };
  }

  return { text: capPostingText(trimmed), kind: 'text' };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Read a posting from a local file: PDFs via `unpdf`, HTML stripped to text, and
 * plain-text/markdown read as UTF-8. Size-checked before reading; the char cap is
 * applied by the caller.
 */
export async function extractPostingFile(filePath: string): Promise<string> {
  const extension = extname(filePath).toLowerCase();

  const { size } = await stat(filePath);
  if (size > MAX_POSTING_FILE_BYTES) {
    throw new Error(`Posting file is too large (${size} bytes; limit is ${MAX_POSTING_FILE_BYTES}).`);
  }

  if (extension === '.pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const data = new Uint8Array(await readFile(filePath));
    const pdf = await getDocumentProxy(data);
    const { text } = await extractText(pdf, { mergePages: true });
    return text.trim();
  }

  const raw = (await readFile(filePath, 'utf8')).trim();
  if (HTML_EXTENSIONS.has(extension)) return htmlToText(raw);
  // Extensionless files count as text here (unlike the CV extractor, which insists on
  // a known extension), and an existing file of unknown type is read best-effort too.
  if (extension === '' || TEXT_FILE_EXTENSIONS.has(extension)) return raw;
  return raw;
}

export { MAX_POSTING_CHARS };
