import { dirname, join } from 'node:path';

/**
 * Coach RAG configuration. The coach is the only agent grounded in retrieval: it
 * queries a single vector index over the `how-to-answer` corpus so its per-answer
 * fixes cite a real answer-craft methodology rather than generic tips. These
 * constants are the contract shared by the ingestion step, the vector store, and
 * the coach's query tool — the embedding model and dimension must match on both
 * sides of the index or a query silently returns nothing.
 */

/** Key the vector store is registered under on the Mastra instance. */
export const KNOWLEDGE_VECTOR_STORE_NAME = 'knowledge';

/** Name of the index within the store that holds the `how-to-answer` chunks. */
export const KNOWLEDGE_INDEX_NAME = 'how_to_answer';

/** Model-router string for the embedding model; the same value ingests and queries. */
export const EMBEDDING_MODEL = 'openai/text-embedding-3-small';

/** Vector dimension for {@link EMBEDDING_MODEL}; the index is created with this size. */
export const EMBEDDING_DIMENSION = 1536;

/** Directory (under `knowledge/`) holding the private, user-supplied corpus. */
export const PRIVATE_CORPUS_DIRNAME = 'how-to-answer';

/** Directory (under `knowledge/`) holding a local sample corpus, when one exists. */
export const SAMPLE_CORPUS_DIRNAME = 'samples';

/**
 * Anchor the vector index beside the main database. The RAG index lives in its own
 * file so its schema stays independent of workflow/memory storage, but in the same
 * `./data/` directory, so it is derived from the already-resolved main database URL
 * rather than re-deriving the project root. `:memory:` is shared as-is so tests never
 * touch disk. A remote main database (e.g. a Turso `libsql://` URL) has no local
 * sibling to derive, and silently reusing it would collapse the RAG index into the
 * workflow/memory store — so it must be given an explicit `KNOWLEDGE_DB_URL` override.
 */
export function knowledgeDbUrl(mastraDbUrl: string, override?: string): string {
  if (override) return override;
  if (mastraDbUrl.startsWith('file:')) {
    const path = mastraDbUrl.slice('file:'.length);
    return `file:${join(dirname(path), 'knowledge.db')}`;
  }
  if (mastraDbUrl === ':memory:') {
    return mastraDbUrl;
  }
  throw new Error(
    `Cannot derive a knowledge vector database from a remote main database URL (${mastraDbUrl}). ` +
      'Set KNOWLEDGE_DB_URL to a dedicated URL for the RAG index.',
  );
}

/**
 * Resolve which corpus to ingest. The private `how-to-answer/` corpus wins when it
 * holds documents; otherwise ingestion falls back to a local `samples/` directory.
 * Neither ships with the repo — the app ships the built index instead, so ingestion
 * is only for replacing it. An explicit override always wins. `hasMarkdown` is
 * injected so the choice is pure and unit-testable.
 */
export function resolveCorpusDir(opts: {
  root: string;
  override?: string;
  hasMarkdown: (dir: string) => boolean;
}): string {
  if (opts.override) return opts.override;
  const privateDir = join(opts.root, 'knowledge', PRIVATE_CORPUS_DIRNAME);
  if (opts.hasMarkdown(privateDir)) return privateDir;
  return join(opts.root, 'knowledge', SAMPLE_CORPUS_DIRNAME);
}
