import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { persistCvUpload } from './cv-upload';

describe('persistCvUpload', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cv-upload-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the uploaded bytes under the uploads dir and returns the path', async () => {
    const bytes = new TextEncoder().encode('# CV\nStaff engineer.');

    const { cvPath } = await persistCvUpload({
      bytes,
      filename: 'resume.md',
      uploadsDir: dir,
      fileId: 'run-1',
    });

    expect(cvPath).toBe(join(dir, 'run-1.md'));
    expect(await readFile(cvPath, 'utf8')).toBe('# CV\nStaff engineer.');
  });

  it('rejects an unsupported file type', async () => {
    await expect(
      persistCvUpload({
        bytes: new Uint8Array([1, 2, 3]),
        filename: 'resume.docx',
        uploadsDir: dir,
        fileId: 'run-1',
      }),
    ).rejects.toThrow(/Unsupported CV file type ".docx"/);
  });

  it('rejects an upload larger than the byte cap', async () => {
    await expect(
      persistCvUpload({
        bytes: new Uint8Array(11),
        filename: 'resume.pdf',
        uploadsDir: dir,
        fileId: 'run-1',
        maxBytes: 10,
      }),
    ).rejects.toThrow(/too large/);
  });

  it('ignores the client filename path, storing under the generated id only', async () => {
    const { cvPath } = await persistCvUpload({
      bytes: new TextEncoder().encode('safe'),
      filename: '../../etc/passwd.txt',
      uploadsDir: dir,
      fileId: 'run-9',
    });

    // Only the extension is trusted; the traversal-laden stem is discarded.
    expect(cvPath).toBe(join(dir, 'run-9.txt'));
    expect(await readFile(cvPath, 'utf8')).toBe('safe');
  });
});
