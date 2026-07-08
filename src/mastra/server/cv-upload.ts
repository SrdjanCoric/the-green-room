import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { MAX_CV_BYTES } from '../tools/extract-cv';

/**
 * How long an uploaded CV survives before the sweep removes it. An upload is only
 * needed for the ingest step of the run it was uploaded for, so a day is generous —
 * the cap exists because every prepare call writes a file, including setups the
 * candidate abandons, and nothing else ever deletes them.
 */
export const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Delete uploads older than the age cap. Best-effort housekeeping: a missing
 * directory or a file that vanishes mid-sweep is fine, and the caller is expected
 * not to await-and-fail a request on it.
 */
export async function sweepStaleUploads(
  uploadsDir: string,
  maxAgeMs: number = UPLOAD_MAX_AGE_MS,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(uploadsDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    names.map(async (name) => {
      const path = join(uploadsDir, name);
      try {
        const info = await stat(path);
        if (info.isFile() && info.mtimeMs < cutoff) await rm(path, { force: true });
      } catch {
        // Raced with another delete or an unreadable entry — housekeeping skips it.
      }
    }),
  );
}

/**
 * CV file extensions the ingest step can read. Mirrors the set accepted by
 * {@link extractCvText}: PDFs are parsed, the rest are read as UTF-8 text.
 */
export const SUPPORTED_CV_EXTENSIONS = new Set([
  '.pdf',
  '.txt',
  '.md',
  '.markdown',
  '.text',
]);

/**
 * A rejected upload the caller may safely report back to the client (unsupported type
 * or too large). It is distinct from a filesystem error, whose raw message could leak
 * server paths and must not be echoed.
 */
export class CvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CvValidationError';
  }
}

export interface PersistCvUploadParams {
  /** The raw bytes of the uploaded CV. */
  bytes: Uint8Array;
  /** The client-supplied filename; only its extension is trusted. */
  filename: string;
  /** Directory the CV is written into (created if missing). */
  uploadsDir: string;
  /** A server-generated unique id; becomes the stored filename stem. */
  fileId: string;
  /** Reject uploads larger than this many bytes. Defaults to {@link MAX_CV_BYTES}. */
  maxBytes?: number;
}

/**
 * Persist a browser-uploaded CV to disk and return the path the interview
 * workflow reads via its `cvPath` input. The stored filename is derived from the
 * server-generated {@link PersistCvUploadParams.fileId} plus the upload's
 * extension only — the client filename's directory and stem are discarded, so a
 * hostile name cannot escape {@link PersistCvUploadParams.uploadsDir}.
 *
 * @throws if the extension is unsupported or the upload exceeds the byte cap.
 */
export async function persistCvUpload(
  params: PersistCvUploadParams,
): Promise<{ cvPath: string }> {
  const maxBytes = params.maxBytes ?? MAX_CV_BYTES;
  const extension = extname(params.filename).toLowerCase();

  if (!SUPPORTED_CV_EXTENSIONS.has(extension)) {
    throw new CvValidationError(
      `Unsupported CV file type "${extension || '(none)'}". Provide a .pdf, .txt, or .md file.`,
    );
  }

  if (params.bytes.byteLength > maxBytes) {
    throw new CvValidationError(
      `CV file is too large (${params.bytes.byteLength} bytes; limit is ${maxBytes}).`,
    );
  }

  await mkdir(params.uploadsDir, { recursive: true });
  const cvPath = join(params.uploadsDir, `${params.fileId}${extension}`);
  await writeFile(cvPath, params.bytes);
  return { cvPath };
}
