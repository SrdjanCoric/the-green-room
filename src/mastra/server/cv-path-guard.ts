import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

/** Request-context key that carries the CV path-trust token. */
export const CV_TRUST_CONTEXT_KEY = 'cvPathTrust';

/**
 * Trust is an entrypoint property, not ambient state: the CLI supplies the operator's
 * own CV path and may read anywhere; a browser-started run must stay confined to the
 * uploads dir. The Mastra server copies client-sent request-context keys into the run,
 * so a boolean flag would be spoofable over HTTP. Instead trust is this per-process
 * random value: an in-process caller (the CLI) copies it into its request context via
 * `grantCvPathTrust`; an HTTP caller can set the key but cannot know the value.
 */
const processTrustToken = randomUUID();

/** Mark a request context as coming from a trusted in-process entrypoint (the CLI). */
export function grantCvPathTrust(requestContext: { set(key: string, value: unknown): void }): void {
  requestContext.set(CV_TRUST_CONTEXT_KEY, processTrustToken);
}

/** True only for contexts granted trust by this process — never for HTTP-supplied values. */
export function isTrustedCvContext(requestContext: { get(key: string): unknown }): boolean {
  return requestContext.get(CV_TRUST_CONTEXT_KEY) === processTrustToken;
}

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
