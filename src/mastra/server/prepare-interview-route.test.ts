import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPrepareInterviewHandler,
  type PrepareInterviewContext,
  prepareInterviewRoute,
} from './prepare-interview-route';

interface Captured {
  data: unknown;
  status: number;
}

/** A minimal stand-in for the Hono context the handler reads from. */
function fakeContext(
  body: Record<string, string | File>,
  headers: Record<string, string> = {},
): {
  c: PrepareInterviewContext;
  captured: () => Captured;
} {
  let captured: Captured = { data: undefined, status: 0 };
  const c: PrepareInterviewContext = {
    req: {
      parseBody: async () => body,
      header: (name: string) => headers[name.toLowerCase()],
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
    expect(captured().data).toMatchObject({ error: expect.stringMatching(/CV/i) });
  });

  it('rejects an unsupported CV type with the validation message', async () => {
    const handler = createPrepareInterviewHandler({ uploadsDir: dir });
    const { c, captured } = fakeContext({
      cv: new File(['x'], 'me.docx'),
      postingKind: 'paste',
    });

    await handler(c);

    expect(captured().status).toBe(400);
    expect(captured().data).toMatchObject({ error: expect.stringMatching(/Unsupported CV/i) });
  });

  it('rejects an over-cap Content-Length before buffering the body', async () => {
    let parsed = false;
    const handler = createPrepareInterviewHandler({ uploadsDir: dir, maxBytes: 1000 });
    const c: PrepareInterviewContext = {
      req: {
        parseBody: async () => {
          parsed = true;
          return {};
        },
        header: (name: string) => (name.toLowerCase() === 'content-length' ? '5000' : undefined),
      },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    };

    const response = await handler(c);

    expect(response.status).toBe(413);
    expect(parsed).toBe(false); // body was never buffered
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
