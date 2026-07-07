import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertCvPathAllowed, isPathWithin } from './cv-path-guard';

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
