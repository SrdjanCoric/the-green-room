import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibSQLVector } from '@mastra/libsql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Embedder } from './embedding';
import { chunkMarkdown, ingestCorpus } from './ingest';

/**
 * A deterministic stand-in for the OpenAI embedder: each text maps to a keyword
 * one-hot vector, so cosine similarity ranks a query nearest the chunk that shares
 * its vocabulary. This exercises the real chunk → embed → upsert → query path
 * without a network call or an API key.
 */
const VOCAB = ['quantify', 'result', 'number', 'ownership', 'decided', 'team'] as const;
const keywordEmbedder: Embedder = async (texts) =>
  texts.map((text) => VOCAB.map((word) => (text.toLowerCase().includes(word) ? 1 : 0)));

describe('chunkMarkdown', () => {
  it('splits a document into non-empty chunks that together preserve its content', async () => {
    const markdown = [
      '# Quantify the result',
      'Every strong answer lands on a number: latency dropped, revenue rose, churn fell.',
      '',
      '## Own the decision',
      'Say what you personally decided, not what the team did around you.',
    ].join('\n');

    const chunks = await chunkMarkdown(markdown);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.trim().length > 0)).toBe(true);
    const combined = chunks.join('\n');
    expect(combined).toContain('Quantify the result');
    expect(combined).toContain('Own the decision');
  });
});

describe('ingestCorpus', () => {
  let corpusDir: string;
  let store: LibSQLVector;
  const indexName = 'test_index';

  beforeEach(async () => {
    corpusDir = await mkdtemp(join(tmpdir(), 'coach-rag-'));
    // File-backed rather than ':memory:': libsql gives each connection its own
    // in-memory database, so a write on one connection is invisible to the next.
    store = new LibSQLVector({ id: 'test-knowledge', url: `file:${join(corpusDir, 'index.db')}` });
  });

  afterEach(async () => {
    await rm(corpusDir, { recursive: true, force: true });
  });

  it('ingests every markdown doc so a query returns the most relevant chunk with its source', async () => {
    await writeFile(
      join(corpusDir, 'quantify.md'),
      '# Quantify the result\nEnd every answer on a number you moved.',
    );
    await writeFile(
      join(corpusDir, 'ownership.md'),
      '# Own the decision\nSay what you personally decided, not what the team did.',
    );

    const result = await ingestCorpus({
      sourceDir: corpusDir,
      store,
      embed: keywordEmbedder,
      indexName,
      dimension: VOCAB.length,
    });

    expect(result.documents).toBe(2);
    expect(result.chunks).toBeGreaterThanOrEqual(2);

    const [queryVector] = await keywordEmbedder(['how do I quantify the result as a number']);
    const matches = await store.query({ indexName, queryVector, topK: 1 });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.metadata?.source).toBe('quantify.md');
    expect(matches[0]?.metadata?.text).toContain('Quantify the result');
  });

  it('creates an empty index and embeds nothing when the corpus has no documents', async () => {
    let embedCalls = 0;
    const countingEmbedder: Embedder = async (texts) => {
      embedCalls += 1;
      return keywordEmbedder(texts);
    };

    const result = await ingestCorpus({
      sourceDir: corpusDir,
      store,
      embed: countingEmbedder,
      indexName,
      dimension: VOCAB.length,
    });

    expect(result).toMatchObject({ documents: 0, chunks: 0 });
    expect(embedCalls).toBe(0);
    await expect(store.query({ indexName, queryVector: new Array(VOCAB.length).fill(0), topK: 1 })).resolves.toEqual(
      [],
    );
  });

  it('treats a missing corpus directory as empty rather than failing the run', async () => {
    const result = await ingestCorpus({
      sourceDir: join(corpusDir, 'does-not-exist'),
      store,
      embed: keywordEmbedder,
      indexName,
      dimension: VOCAB.length,
    });

    expect(result).toMatchObject({ documents: 0, chunks: 0 });
  });
});
