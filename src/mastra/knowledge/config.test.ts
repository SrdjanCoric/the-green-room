import { describe, expect, it } from 'vitest';

import { knowledgeDbUrl, resolveCorpusDir } from './config';

describe('knowledgeDbUrl', () => {
  it('anchors the vector index beside the main database file', () => {
    expect(knowledgeDbUrl('file:/repo/data/mastra.db')).toBe('file:/repo/data/knowledge.db');
  });

  it('honours an explicit override over the derived path', () => {
    expect(knowledgeDbUrl('file:/repo/data/mastra.db', 'file:/tmp/other.db')).toBe(
      'file:/tmp/other.db',
    );
  });

  it('shares an in-memory database so tests never touch disk', () => {
    expect(knowledgeDbUrl(':memory:')).toBe(':memory:');
  });

  it('refuses to derive a path from a remote main database, to avoid collapsing the two stores', () => {
    expect(() => knowledgeDbUrl('libsql://team.turso.io')).toThrow(/KNOWLEDGE_DB_URL/);
  });

  it('allows a remote main database when an explicit knowledge URL is given', () => {
    expect(knowledgeDbUrl('libsql://team.turso.io', 'libsql://knowledge.turso.io')).toBe(
      'libsql://knowledge.turso.io',
    );
  });
});

describe('resolveCorpusDir', () => {
  const hasMarkdown = (dirs: string[]) => (dir: string) => dirs.includes(dir);

  it('prefers the private how-to-answer corpus when it holds documents', () => {
    expect(
      resolveCorpusDir({ root: '/repo', hasMarkdown: hasMarkdown(['/repo/knowledge/how-to-answer']) }),
    ).toBe('/repo/knowledge/how-to-answer');
  });

  it('falls back to the committed samples when the private corpus is empty or absent', () => {
    expect(resolveCorpusDir({ root: '/repo', hasMarkdown: hasMarkdown([]) })).toBe(
      '/repo/knowledge/samples',
    );
  });

  it('honours an explicit override directory', () => {
    expect(
      resolveCorpusDir({ root: '/repo', override: '/data/docs', hasMarkdown: hasMarkdown([]) }),
    ).toBe('/data/docs');
  });
});
