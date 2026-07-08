import { randomUUID } from 'node:crypto';

import { registerApiRoute } from '@mastra/core/server';
import { bodyLimit } from 'hono/body-limit';

import { MAX_CV_BYTES } from '../tools/extract-cv';
import type { ResolvePostingOptions } from '../tools/resolve-posting';
import { CvValidationError, persistCvUpload, sweepStaleUploads } from './cv-upload';
import { type PostingInputKind, preparePosting } from './prepare-posting';
import { uploadsDir } from './uploads-dir';

/**
 * The most this route reads of any request body: the CV byte cap plus headroom for
 * the multipart framing and the pasted posting text. Enforced by streaming — a body
 * with no declared Content-Length is counted as it arrives and dropped at the cap,
 * so a hostile chunked upload cannot buffer unbounded memory; the exact per-file cap
 * is still enforced after decode by {@link persistCvUpload}.
 */
export const PREPARE_BODY_LIMIT_BYTES = MAX_CV_BYTES + 256 * 1024;

/** The streaming body-size guard mounted in front of the prepare handler. */
export function createPrepareBodyLimit(maxSize: number = PREPARE_BODY_LIMIT_BYTES) {
  return bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: 'The CV file is too large.' }, 413),
  });
}

/**
 * The slice of the Hono request context this handler reads. Kept minimal so the
 * wiring is unit-testable without constructing a full server context; the real
 * Hono `Context` structurally satisfies it.
 */
export interface PrepareInterviewContext {
  req: {
    parseBody: () => Promise<Record<string, string | File>>;
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
  /** Stale-upload housekeeping; defaults to {@link sweepStaleUploads}. */
  sweepUploads?: (uploadsDir: string) => Promise<void>;
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
  const sweepUploads = deps.sweepUploads ?? sweepStaleUploads;
  return async (c: PrepareInterviewContext): Promise<Response> => {
    // Every prepare call writes a file, including setups the candidate abandons, so
    // each call also sweeps expired ones. Fire-and-forget: housekeeping must never
    // fail or slow the request it rides on. (Over-cap bodies never reach this
    // handler — the route mounts a streaming body limit in front of it.)
    void sweepUploads(deps.uploadsDir).catch(() => {
      /* best-effort housekeeping — never fail the request it rides on */
    });

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
  // `@mastra/core` bundles a vendored copy of the hono types, so the `MiddlewareHandler`
  // from the `hono` package is a distinct nominal type from the one `registerApiRoute`
  // expects — identical at runtime (same hono version), so the array is cast across.
  middleware: [createPrepareBodyLimit()] as unknown as Parameters<
    typeof registerApiRoute
  >[1]['middleware'],
  handler: createPrepareInterviewHandler({ uploadsDir }),
});
