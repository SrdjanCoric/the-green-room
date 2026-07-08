import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Hono } from 'hono';

import {
  createPrepareBodyLimit,
  createPrepareInterviewHandler,
  PREPARE_BODY_LIMIT_BYTES,
  type PrepareInterviewContext,
  prepareInterviewRoute,
} from './prepare-interview-route';

interface Captured {
  data: unknown;
  status: number;
}

/** A minimal stand-in for the Hono context the handler reads from. */
function fakeContext(body: Record<string, string | File>): {
  c: PrepareInterviewContext;
  captured: () => Captured;
} {
  let captured: Captured = { data: undefined, status: 0 };
  const c: PrepareInterviewContext = {
    req: {
      parseBody: async () => body,
    },
    json: (data: unknown, status = 200) => {
      captured = { data, status };
      return new Response(JSON.stringify(data), { status });
    },
  };
  return { c, captured: () => captured };
}

describe('prepareInterviewRoute wiring', () => {
  it('is registered as POST /prepare-interview', () => {
    expect(prepareInterviewRoute.path).toBe('/prepare-interview');
    expect(prepareInterviewRoute.method).toBe('POST');
  });

  it('mounts a body-size limit in front of the handler', () => {
    // The handler never sees a body the limit rejected, so the middleware must be
    // wired on the route itself; the cap leaves headroom over the CV byte cap for
    // the multipart framing and the pasted posting text.
    expect(prepareInterviewRoute.middleware).toBeDefined();
    expect(PREPARE_BODY_LIMIT_BYTES).toBeGreaterThan(0);
  });
});

describe('prepare-interview body limit', () => {
  function appWithLimit(maxSize: number): { app: Hono; handled: () => boolean } {
    let handled = false;
    const app = new Hono();
    app.use('/prepare-interview', createPrepareBodyLimit(maxSize));
    app.post('/prepare-interview', (c) => {
      handled = true;
      return c.json({ ok: true });
    });
    return { app, handled: () => handled };
  }

  it('rejects an over-cap declared Content-Length before the handler runs', async () => {
    const { app, handled } = appWithLimit(1_000);

    const response = await app.request('/prepare-interview', {
      method: 'POST',
      headers: { 'content-length': '5000' },
      body: 'x',
    });

    expect(response.status).toBe(413);
    expect(handled()).toBe(false);
  });

  it('rejects an over-cap chunked body without buffering it fully', async () => {
    const { app, handled } = appWithLimit(1_000);

    // A body with no declared length: the route must count as it reads and stop
    // at the cap instead of buffering all hundred chunks into memory first.
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 100) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(512));
      },
    });

    const response = await app.request('/prepare-interview', {
      method: 'POST',
      body,
      // @ts-expect-error Node's fetch types lag the runtime: streaming bodies need half duplex.
      duplex: 'half',
    });

    expect(response.status).toBe(413);
    expect(handled()).toBe(false);
    expect(pulls).toBeLessThan(10); // reading stopped at the cap, ~3 chunks in
  });
});

describe('prepare-interview route handler', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prepare-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists the CV and returns the assembled workflow inputs', async () => {
    const handler = createPrepareInterviewHandler({
      uploadsDir: dir,
      generateId: () => 'run-7',
    });
    const { c, captured } = fakeContext({
      cv: new File(['# CV\nStaff.'], 'me.md', { type: 'text/markdown' }),
      job: 'Staff Engineer, pasted.',
      postingKind: 'paste',
    });

    await handler(c);

    const { data, status } = captured();
    expect(status).toBe(200);
    expect(data).toEqual({
      cvPath: join(dir, 'run-7.md'),
      postingText: 'Staff Engineer, pasted.',
      researchUrls: [],
    });
    expect(await readFile(join(dir, 'run-7.md'), 'utf8')).toBe('# CV\nStaff.');
  });

  it('rejects a request with no CV file', async () => {
    const handler = createPrepareInterviewHandler({ uploadsDir: dir });
    const { c, captured } = fakeContext({ job: 'x', postingKind: 'paste' });

    await handler(c);

    expect(captured().status).toBe(400);
    expect(captured().data).toMatchObject({ error: expect.stringMatching(/CV/i) as unknown });
  });

  it('rejects an unsupported CV type with the validation message', async () => {
    const handler = createPrepareInterviewHandler({ uploadsDir: dir });
    const { c, captured } = fakeContext({
      cv: new File(['x'], 'me.docx'),
      postingKind: 'paste',
    });

    await handler(c);

    expect(captured().status).toBe(400);
    expect(captured().data).toMatchObject({
      error: expect.stringMatching(/Unsupported CV/i) as unknown,
    });
  });

  it('sweeps stale uploads on each prepare call, without failing the request on it', async () => {
    const sweep = vi.fn(async () => {
      /* records the call; the sweep itself is unit-tested in cv-upload.test.ts */
    });
    const handler = createPrepareInterviewHandler({
      uploadsDir: dir,
      generateId: () => 'run-7',
      sweepUploads: sweep,
    });
    const { c, captured } = fakeContext({
      cv: new File(['cv'], 'me.md'),
      postingKind: 'paste',
    });

    await handler(c);

    expect(captured().status).toBe(200);
    expect(sweep).toHaveBeenCalledWith(dir);
  });

  it('resolves a posting link through the injected resolver', async () => {
    const fetchPosting = vi.fn(async () => ({
      text: 'Posting body.',
      url: 'https://jobs.example.com/staff',
    }));
    const handler = createPrepareInterviewHandler({
      uploadsDir: dir,
      generateId: () => 'run-8',
      resolveOptions: { fetchPosting },
    });
    const { c, captured } = fakeContext({
      cv: new File(['cv'], 'me.txt'),
      job: 'https://jobs.example.com/staff',
      postingKind: 'link',
    });

    await handler(c);

    expect(captured().data).toEqual({
      cvPath: join(dir, 'run-8.txt'),
      postingText: 'Posting body.',
      researchUrls: ['https://jobs.example.com/staff'],
    });
    expect(fetchPosting).toHaveBeenCalledOnce();
  });
});
