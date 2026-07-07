import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Environment flag that opts a process out of CV-path confinement. The CLI sets it
 * because the operator supplies their own trusted CV path; `mastra dev` (the web
 * backend) never sets it, so a browser-started run stays confined to the uploads dir.
 */
export const CV_PATH_TRUST_ENV = 'INTERVIEW_COACH_TRUST_LOCAL_CV';

/** True when `candidate` resolves to `baseDir` itself or a path nested inside it. */
export function isPathWithin(baseDir: string, candidate: string): boolean {
  const base = resolve(baseDir);
  const target = resolve(candidate);
  if (target === base) return true;
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export interface CvPathGuardOptions {
  /** The only directory a client-supplied CV path may live in. */
  uploadsDir: string;
  /** When true, skip confinement (a trusted operator, e.g. the CLI). */
  trustLocalPaths?: boolean;
}

/**
 * Reject a `cvPath` that is not inside the allowed uploads directory. This closes the
 * arbitrary-file-read hole that opens once the interview workflow is driven over the
 * Mastra server: a client controls `cvPath`, so without this an attacker could read
 * any readable file on the host. Trusted callers (the CLI) opt out.
 *
 * @throws if the path escapes the uploads directory and local paths are not trusted.
 */
export function assertCvPathAllowed(cvPath: string, options: CvPathGuardOptions): void {
  if (options.trustLocalPaths) return;
  if (!isPathWithin(options.uploadsDir, cvPath)) {
    throw new Error('The CV path is outside the allowed upload directory.');
  }
}
