import { randomUUID } from 'node:crypto';

import { registerApiRoute } from '@mastra/core/server';

import { MAX_CV_BYTES } from '../tools/extract-cv';
import type { ResolvePostingOptions } from '../tools/resolve-posting';
import { CvValidationError, persistCvUpload } from './cv-upload';
import { type PostingInputKind, preparePosting } from './prepare-posting';
import { uploadsDir } from './uploads-dir';

/**
 * The slice of the Hono request context this handler reads. Kept minimal so the
 * wiring is unit-testable without constructing a full server context; the real
 * Hono `Context` structurally satisfies it.
 */
export interface PrepareInterviewContext {
  req: {
    parseBody: () => Promise<Record<string, string | File>>;
    header: (name: string) => string | undefined;
  };
  json: (data: unknown, status?: number) => Response;
}

export interface PrepareInterviewHandlerDeps {
  /** Directory uploaded CVs are written to. */
  uploadsDir: string;
  /** Unique-id source for the stored filename; defaults to {@link randomUUID}. */
  generateId?: () => string;
  /** Reject uploads larger than this many bytes. Defaults to {@link MAX_CV_BYTES}. */
  maxBytes?: number;
  /** Injected posting-resolver options, for tests. */
  resolveOptions?: ResolvePostingOptions;
}

/**
 * Build the `POST /prepare-interview` handler: it persists the uploaded CV, resolves
 * the posting (link or pasted text) server-side, and returns the `cvPath`,
 * `postingText`, and `researchUrls` the browser then feeds into the interview
 * workflow via `@mastra/client-js`. This is the only server-only work the web client
 * cannot do itself — writing the CV to disk and running the SSRF-guarded posting
 * fetch — so the interview workflow and agents stay untouched.
 */
export function createPrepareInterviewHandler(deps: PrepareInterviewHandlerDeps) {
  const generateId = deps.generateId ?? randomUUID;
  const maxBytes = deps.maxBytes ?? MAX_CV_BYTES;
  return async (c: PrepareInterviewContext): Promise<Response> => {
    // Reject an over-cap upload from its Content-Length before buffering the body, so
    // a hostile multi-GB request can't exhaust memory. The exact byte cap is enforced
    // again after decode; this precheck just avoids reading a body we'd reject anyway.
    const declaredLength = Number(c.req.header('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return c.json({ error: 'The CV file is too large.' }, 413);
    }

    const body = await c.req.parseBody();
    const cv = body.cv;
    if (!(cv instanceof File)) {
      return c.json({ error: 'A CV file is required.' }, 400);
    }

    let cvPath: string;
    try {
      const bytes = new Uint8Array(await cv.arrayBuffer());
      ({ cvPath } = await persistCvUpload({
        bytes,
        filename: cv.name,
        uploadsDir: deps.uploadsDir,
        fileId: generateId(),
        maxBytes,
      }));
    } catch (error) {
      // Only echo validation messages; a raw filesystem error could leak server paths.
      if (error instanceof CvValidationError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: 'Could not store the uploaded CV.' }, 500);
    }

    const job = typeof body.job === 'string' ? body.job : undefined;
    const kind: PostingInputKind = body.postingKind === 'link' ? 'link' : 'paste';
    const posting = await preparePosting({ job, kind, resolveOptions: deps.resolveOptions });

    return c.json({ cvPath, ...posting });
  };
}

/**
 * The additive server route the web UI calls before starting a run. Registered on
 * the Mastra `server.apiRoutes`; served at the root, i.e. `/prepare-interview`.
 */
export const prepareInterviewRoute = registerApiRoute('/prepare-interview', {
  method: 'POST',
  handler: createPrepareInterviewHandler({ uploadsDir }),
});
