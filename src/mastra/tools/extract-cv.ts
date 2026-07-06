import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

/** File extensions read directly as UTF-8 text. */
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.text']);

/**
 * Default upper bound on the CV file size, checked before the file is read. A CV
 * is typically third-party authored, so this guards the PDF parser and process
 * memory against a hostile or accidentally huge file.
 */
export const MAX_CV_BYTES = 10 * 1024 * 1024;

/**
 * Default upper bound on the extracted text length. The text is fed to a paid
 * model, so this caps the request size (and cost) regardless of the source file.
 */
export const MAX_CV_CHARS = 200_000;

export interface ExtractCvOptions {
  /** Reject files larger than this many bytes. Defaults to {@link MAX_CV_BYTES}. */
  maxBytes?: number;
  /** Truncate extracted text to this many characters. Defaults to {@link MAX_CV_CHARS}. */
  maxChars?: number;
}

/**
 * Extract the plain text of a CV from disk. PDFs are parsed with pdf.js (via
 * `unpdf`); plain-text and markdown files are read directly as UTF-8. The returned
 * text is what the CV-parser agent reads — it is never rendered to the user — so no
 * layout or formatting is preserved, only the textual content.
 *
 * The file is size-checked before reading and the extracted text is truncated to a
 * character cap, so an oversized or hostile CV can't exhaust memory or balloon the
 * downstream model request.
 *
 * @throws if the file type is unsupported or the file exceeds the byte cap.
 */
export async function extractCvText(filePath: string, options: ExtractCvOptions = {}): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_CV_BYTES;
  const maxChars = options.maxChars ?? MAX_CV_CHARS;
  const extension = extname(filePath).toLowerCase();

  if (extension !== '.pdf' && !TEXT_EXTENSIONS.has(extension)) {
    throw new Error(
      `Unsupported CV file type "${extension || '(none)'}". Provide a .pdf, .txt, or .md file.`,
    );
  }

  const { size } = await stat(filePath);
  if (size > maxBytes) {
    throw new Error(`CV file is too large (${size} bytes; limit is ${maxBytes}).`);
  }

  const text = extension === '.pdf' ? await extractPdfText(filePath) : await readTextFile(filePath);
  return truncate(text, maxChars);
}

/** Truncate to a character cap without leaving a split surrogate pair at the boundary. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const lastCode = sliced.charCodeAt(sliced.length - 1);
  // A lone high surrogate (0xD800–0xDBFF) at the end means we split an astral
  // character; drop it so the result stays valid UTF-16.
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

async function readTextFile(filePath: string): Promise<string> {
  return (await readFile(filePath, 'utf8')).trim();
}

async function extractPdfText(filePath: string): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const data = new Uint8Array(await readFile(filePath));
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: true });
  return text.trim();
}
