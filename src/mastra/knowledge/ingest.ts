import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { MastraVector } from '@mastra/core/vector';
import { MDocument } from '@mastra/rag';

import { EMBEDDING_DIMENSION, KNOWLEDGE_INDEX_NAME } from './config';
import type { Embedder } from './embedding';

/** One embedded passage: the chunk text plus the file it came from, for citation. */
export interface KnowledgeChunk {
  text: string;
  source: string;
}

/** Summary of an ingest run, for the CLI to report. */
export interface IngestResult {
  documents: number;
  chunks: number;
  indexName: string;
}

/**
 * Chunk a markdown document into retrieval-sized passages. The markdown-native
 * strategy splits on document structure (headings, then paragraphs), keeping each
 * answer-craft point whole where it can, then bounds the size so an embedding
 * captures one focused idea. Empty chunks are dropped so nothing blank is embedded.
 */
export async function chunkMarkdown(markdown: string): Promise<string[]> {
  const doc = MDocument.fromMarkdown(markdown);
  const chunks = await doc.chunk({
    strategy: 'markdown',
    maxSize: 800,
    overlap: 100,
  });
  return chunks.map((chunk) => chunk.text).filter((text) => text.trim().length > 0);
}

/**
 * Read and chunk every markdown file in a directory, tagging each chunk with its
 * source filename. Files are read in sorted order so an ingest run is deterministic.
 * A missing directory is treated as an empty corpus rather than an error, so a
 * misconfigured or absent corpus path yields an empty index instead of a crash.
 */
export async function readCorpusChunks(sourceDir: string): Promise<KnowledgeChunk[]> {
  let entries: string[];
  try {
    entries = await readdir(sourceDir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const files = entries.filter((name) => name.endsWith('.md')).sort();
  const chunks: KnowledgeChunk[] = [];
  for (const file of files) {
    const markdown = await readFile(join(sourceDir, file), 'utf8');
    for (const text of await chunkMarkdown(markdown)) {
      chunks.push({ text, source: file });
    }
  }
  return chunks;
}

/**
 * Ingest a corpus directory into the vector index: read and chunk every markdown
 * file, embed the chunks, and upsert them with their text and source in metadata
 * (the coach's query tool surfaces `metadata.text` as retrieved context and
 * `metadata.source` for citation). The index is dropped and recreated first so each
 * run is a clean rebuild rather than appending stale chunks; each chunk's id is its
 * source filename plus its global position in the corpus (`source#index`), so a
 * rebuild of the same corpus is reproducible.
 */
export async function ingestCorpus(opts: {
  sourceDir: string;
  store: MastraVector;
  embed: Embedder;
  indexName?: string;
  dimension?: number;
}): Promise<IngestResult> {
  const indexName = opts.indexName ?? KNOWLEDGE_INDEX_NAME;
  const dimension = opts.dimension ?? EMBEDDING_DIMENSION;

  // Drop any prior index so a rebuild never leaves orphaned chunks (e.g. from a doc
  // that shrank or was removed). Absent on the first run, which is not an error.
  try {
    await opts.store.deleteIndex({ indexName });
  } catch {
    // No existing index to drop.
  }
  await opts.store.createIndex({ indexName, dimension });

  const chunks = await readCorpusChunks(opts.sourceDir);
  const sources = new Set(chunks.map((chunk) => chunk.source));
  if (chunks.length === 0) {
    return { documents: 0, chunks: 0, indexName };
  }

  const vectors = await opts.embed(chunks.map((chunk) => chunk.text));
  await opts.store.upsert({
    indexName,
    vectors,
    metadata: chunks.map((chunk) => ({ text: chunk.text, source: chunk.source })),
    ids: chunks.map((chunk, index) => `${chunk.source}#${index}`),
  });

  return { documents: sources.size, chunks: chunks.length, indexName };
}
