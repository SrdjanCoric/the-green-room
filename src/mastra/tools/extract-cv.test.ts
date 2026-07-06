import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractCvText } from './extract-cv';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

describe('extractCvText', () => {
  it('reads a markdown CV as UTF-8 text', async () => {
    const text = await extractCvText(join(fixtures, 'sample-cv.md'));

    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('Reduced batch runtime by 40%');
  });

  it('extracts text from a PDF CV', async () => {
    const text = await extractCvText(join(fixtures, 'sample-cv.pdf'));

    expect(text).toContain('Grace Hopper');
    expect(text).toContain('Principal Engineer');
  });

  it('rejects an unsupported file type', async () => {
    await expect(extractCvText(join(fixtures, 'sample-cv.docx'))).rejects.toThrow(/unsupported/i);
  });

  it('rejects a file larger than the byte cap before reading it', async () => {
    await expect(
      extractCvText(join(fixtures, 'sample-cv.md'), { maxBytes: 10 }),
    ).rejects.toThrow(/too large/i);
  });

  it('truncates extracted text to the character cap', async () => {
    const text = await extractCvText(join(fixtures, 'sample-cv.md'), { maxChars: 12 });

    expect(text).toHaveLength(12);
    expect(text).toBe('# Ada Lovela');
  });
});
