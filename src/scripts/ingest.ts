import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';

import { describeError } from '../mastra/errors';
import { resolveCorpusDir } from '../mastra/knowledge/config';
import { createRouterEmbedder } from '../mastra/knowledge/embedding';
import { ingestCorpus } from '../mastra/knowledge/ingest';
import { KNOWLEDGE_DB_URL, knowledgeVectorStore } from '../mastra/knowledge/vector-store';

/**
 * `npm run ingest` — build the coach's `how-to-answer` vector index from local
 * markdown, replacing the index the app ships at `data/knowledge.db`. The corpus is
 * `KNOWLEDGE_CORPUS_DIR` when set, otherwise a local `knowledge/` directory (neither
 * ships with the repo — a fresh clone already has the built index and never needs to
 * run this). Embedding uses OpenAI `text-embedding-3-small`, so `OPENAI_API_KEY`
 * must be set.
 */

// The app does not otherwise load a dotenv file; load it best-effort here so the key
// from `.env` is available when this runs standalone under tsx. An ambient key still
// wins if there is no file.
try {
  process.loadEnvFile();
} catch {
  // No .env file present — rely on the ambient environment.
}

/** A directory counts as a corpus only if it actually holds markdown. */
function hasMarkdown(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.endsWith('.md'));
  } catch {
    return false;
  }
}

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceDir = resolveCorpusDir({
  root: projectRoot,
  override: process.env.KNOWLEDGE_CORPUS_DIR,
  hasMarkdown,
});

// A fresh clone has no corpus directory at all — and doesn't need one: the built
// index ships at data/knowledge.db. Say so instead of failing on a missing folder.
if (!hasMarkdown(sourceDir)) {
  console.log(
    `No markdown corpus found at ${sourceDir}. The app already ships a built index at ` +
      'data/knowledge.db; set KNOWLEDGE_CORPUS_DIR to a directory of markdown files to ' +
      'replace it with your own.',
  );
  process.exit(0);
}

async function main(): Promise<void> {
  console.log(`Ingesting how-to-answer corpus from ${sourceDir} …`);
  const result = await ingestCorpus({
    sourceDir,
    store: knowledgeVectorStore,
    embed: createRouterEmbedder(),
  });
  console.log(
    `Indexed ${result.chunks} chunk(s) from ${result.documents} document(s) into "${result.indexName}".`,
  );
  await compact(result.indexName);
}

/**
 * Drop the native vector index and reclaim its space, leaving a compact database.
 * The index's shadow structures preallocate hundreds of kilobytes per row (~350 MB
 * for ~1k chunks — far past what a repo can carry), while the query layer falls
 * back to an exact scan when no native index exists, which at this corpus size is
 * milliseconds and returns identical results. The committed `data/knowledge.db`
 * must stay in the compact form, so ingestion always finishes here.
 */
async function compact(indexName: string): Promise<void> {
  if (!KNOWLEDGE_DB_URL.startsWith('file:')) return;
  const db = createClient({ url: KNOWLEDGE_DB_URL });
  try {
    await db.execute(`DROP INDEX IF EXISTS ${indexName}_vector_idx`);
    await db.execute('VACUUM');
    await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    console.log('Compacted the index for exact-scan retrieval.');
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error('Ingestion failed:', describeError(error));
  process.exitCode = 1;
});
