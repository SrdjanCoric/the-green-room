import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';

import {
  assertCvPathAllowed,
  CV_TRUST_CONTEXT_KEY,
  grantCvPathTrust,
  isPathWithin,
  isTrustedCvContext,
} from './cv-path-guard';

const base = '/srv/app/data/uploads';

describe('isPathWithin', () => {
  it('accepts a file directly inside the base directory', () => {
    expect(isPathWithin(base, join(base, 'run-1.md'))).toBe(true);
  });

  it('accepts the base directory itself', () => {
    expect(isPathWithin(base, base)).toBe(true);
  });

  it('rejects a traversal that escapes the base directory', () => {
    expect(isPathWithin(base, join(base, '..', '..', 'secret.env'))).toBe(false);
    expect(isPathWithin(base, '/etc/passwd')).toBe(false);
  });

  it('rejects a sibling directory that shares a name prefix', () => {
    expect(isPathWithin(base, '/srv/app/data/uploads-evil/x.md')).toBe(false);
  });
});

describe('assertCvPathAllowed', () => {
  it('rejects a path outside the uploads dir when local paths are not trusted', () => {
    expect(() => assertCvPathAllowed('/etc/passwd', { uploadsDir: base })).toThrow(
      /outside the allowed upload directory/i,
    );
  });

  it('allows a path inside the uploads dir', () => {
    expect(() => assertCvPathAllowed(join(base, 'run-1.md'), { uploadsDir: base })).not.toThrow();
  });

  it('allows any path when local paths are trusted (the CLI operator)', () => {
    expect(() =>
      assertCvPathAllowed('/home/me/cv.pdf', { uploadsDir: base, trustLocalPaths: true }),
    ).not.toThrow();
  });
});

describe('CV path trust token', () => {
  it('trusts a context this process granted trust to', () => {
    const requestContext = new RequestContext();
    grantCvPathTrust(requestContext);
    expect(isTrustedCvContext(requestContext)).toBe(true);
  });

  it('never trusts a context without the grant', () => {
    expect(isTrustedCvContext(new RequestContext())).toBe(false);
  });

  it('never trusts a client that sets the key with a guessed value', () => {
    // Over HTTP every request-context key is caller-controlled, so possession of
    // the key name must not grant trust — only the per-process value can.
    for (const guess of ['1', 'true', randomUUID()]) {
      const requestContext = new RequestContext();
      requestContext.set(CV_TRUST_CONTEXT_KEY, guess);
      expect(isTrustedCvContext(requestContext)).toBe(false);
    }
  });
});
