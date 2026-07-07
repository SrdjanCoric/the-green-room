import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { LibSQLVector } from '@mastra/libsql';

import { dbUrl as mastraDbUrl } from '../storage';
import { knowledgeDbUrl } from './config';

/**
 * The RAG vector index for the coach's `how-to-answer` corpus. It is a separate
 * LibSQL database from the workflow/memory store so their schemas stay independent,
 * but it lives beside `mastra.db` in the same `./data/` directory (both gitignored).
 * The ingest command writes this file and the coach's query tool reads it, so both
 * must resolve to the same URL — hence it is derived from the shared main database
 * URL. `KNOWLEDGE_DB_URL` overrides it (e.g. a Turso URL); a non-file main database
 * (`:memory:` in tests) is shared as-is.
 */
export const KNOWLEDGE_DB_URL = knowledgeDbUrl(mastraDbUrl, process.env.KNOWLEDGE_DB_URL);

// LibSQL opens file-backed databases eagerly, so ensure the directory exists first.
if (KNOWLEDGE_DB_URL.startsWith('file:')) {
  mkdirSync(dirname(KNOWLEDGE_DB_URL.slice('file:'.length)), { recursive: true });
}

export const knowledgeVectorStore = new LibSQLVector({
  id: 'knowledge',
  url: KNOWLEDGE_DB_URL,
});
