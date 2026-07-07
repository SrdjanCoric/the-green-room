import type { PostingInputKind } from './types';

/** What the setup form sends to the preflight route. */
export interface PrepareInterviewRequest {
  cv: File;
  job: string;
  postingKind: PostingInputKind;
}

/** The preflight response: the assembled server-side workflow inputs. */
export interface PrepareInterviewResponse {
  cvPath: string;
  postingText?: string;
  researchUrls: string[];
  postingFetchFailedUrl?: string;
}

/**
 * Persist the uploaded CV and resolve the posting server-side via the additive
 * `/prepare-interview` route, returning the inputs the interview run then needs. This
 * is the one step the browser cannot do itself (writing the CV to disk; the
 * SSRF-guarded posting fetch); the interview run proper is driven with
 * `@mastra/client-js`.
 */
export async function prepareInterview(
  request: PrepareInterviewRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<PrepareInterviewResponse> {
  const form = new FormData();
  form.set('cv', request.cv);
  form.set('job', request.job);
  form.set('postingKind', request.postingKind);

  const response = await fetchImpl('/prepare-interview', { method: 'POST', body: form });
  const data = (await response.json().catch(() => ({}))) as Partial<PrepareInterviewResponse> & {
    error?: string;
  };

  if (!response.ok) {
    throw new Error(data.error ?? 'Could not prepare the interview inputs.');
  }
  return {
    cvPath: data.cvPath ?? '',
    postingText: data.postingText,
    researchUrls: data.researchUrls ?? [],
    postingFetchFailedUrl: data.postingFetchFailedUrl,
  };
}
