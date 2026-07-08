import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { LibSQLStore } from '@mastra/libsql';

import { dataDir } from './data-dir';

/**
 * Resolve the one canonical database URL every entrypoint must share.
 *
 * The database lives inside the shared `data/` directory (see `data-dir.ts`, which
 * anchors it to the project root and honors `INTERVIEW_COACH_DATA_DIR`), so the CLI
 * and `mastra dev` read and write the same file — a cwd-relative path would silently
 * fork into separate databases. `dataDir` and `override` are injectable so the
 * resolution is unit-testable without touching the process environment.
 *
 * @param dataDir the resolved shared data directory
 * @param override an explicit URL (e.g. `INTERVIEW_COACH_DB_URL`); empty is ignored
 */
export function resolveDbUrl(dataDir: string, override?: string): string {
  if (override) return override;
  return `file:${join(dataDir, 'mastra.db')}`;
}

/**
 * The one resolved database URL for this process. Exported so sibling stores (e.g.
 * the RAG vector index) can anchor their own file beside `mastra.db` in the same
 * `./data/` directory rather than re-deriving the project root.
 */
export const dbUrl = resolveDbUrl(dataDir, process.env.INTERVIEW_COACH_DB_URL);

// LibSQL opens file-backed databases eagerly, so make sure the directory exists
// first. In-memory databases (used by tests) have no directory to create.
if (dbUrl.startsWith('file:')) {
  mkdirSync(dirname(dbUrl.slice('file:'.length)), { recursive: true });
}

/**
 * A single LibSQL store backs workflow snapshots, memory, and scorer results. The
 * default file lives under `./data/` (gitignored) and is shared with `mastra dev`,
 * so Studio reads the same database this process writes to. The one store instance
 * is shared across the Mastra instance and the candidate memory so both see the
 * same tables — critical for the in-memory database tests use, where each new
 * connection would otherwise get its own empty database.
 */
export const storage = new LibSQLStore({
  id: 'interview-coach',
  url: dbUrl,
});
