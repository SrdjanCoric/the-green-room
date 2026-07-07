import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeError } from '../mastra/errors';
import { resolveCorpusDir } from '../mastra/knowledge/config';
import { createRouterEmbedder } from '../mastra/knowledge/embedding';
import { ingestCorpus } from '../mastra/knowledge/ingest';
import { knowledgeVectorStore } from '../mastra/knowledge/vector-store';

/**
 * `npm run ingest` — build the coach's `how-to-answer` vector index from local
 * markdown. It reads the private `knowledge/how-to-answer/` corpus when present and
 * falls back to the committed `knowledge/samples/` so the app runs out of the box.
 * Embedding uses OpenAI `text-embedding-3-small`, so `OPENAI_API_KEY` must be set.
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
}

main().catch((error: unknown) => {
  console.error('Ingestion failed:', describeError(error));
  process.exitCode = 1;
});
