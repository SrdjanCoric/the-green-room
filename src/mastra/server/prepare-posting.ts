import { capPostingText } from '../tools/fetch-posting';
import { type ResolvePostingOptions, resolvePosting } from '../tools/resolve-posting';

/** How the browser presented the posting: a link to fetch, or literal pasted text. */
export type PostingInputKind = 'link' | 'paste';

export interface PreparePostingParams {
  /** The posting value: a URL when {@link kind} is `link`, otherwise literal text. */
  job?: string;
  /** Which setup control the value came from. */
  kind: PostingInputKind;
  /** Injected resolver options, for tests. */
  resolveOptions?: ResolvePostingOptions;
}

export interface PreparedPosting {
  /** Resolved posting text for the workflow's `postingText` input; omitted for a generic interview. */
  postingText?: string;
  /** URLs the research step may fetch for company context (the posting's final URL, if any). */
  researchUrls: string[];
  /** Set when a link could not be fetched, so the UI can offer the paste fallback. */
  postingFetchFailedUrl?: string;
}

/**
 * Turn the browser's posting input into the workflow's `postingText`/`researchUrls`
 * inputs, keeping the two server-only concerns off the client. A `link` is fetched
 * through the SSRF-guarded {@link resolvePosting} (a failure is returned as
 * {@link PreparedPosting.postingFetchFailedUrl} rather than thrown, so a broken link
 * never blocks the interview); `paste` text is taken literally and only capped, so
 * pasted content never triggers a network fetch or filesystem read.
 */
export async function preparePosting(params: PreparePostingParams): Promise<PreparedPosting> {
  const job = params.job?.trim();
  if (!job) return { postingText: undefined, researchUrls: [] };

  if (params.kind === 'paste') {
    return { postingText: capPostingText(job), researchUrls: [] };
  }

  if (!isHttpUrl(job)) {
    return { postingText: undefined, researchUrls: [], postingFetchFailedUrl: job };
  }

  try {
    const resolved = await resolvePosting(job, params.resolveOptions);
    return {
      postingText: resolved.text,
      researchUrls: resolved.url ? [resolved.url] : [],
    };
  } catch {
    return { postingText: undefined, researchUrls: [], postingFetchFailedUrl: job };
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
