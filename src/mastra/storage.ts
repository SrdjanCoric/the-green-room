import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LibSQLStore } from '@mastra/libsql';

/**
 * Resolve the one canonical database URL every entrypoint must share.
 *
 * The database is anchored to the project root so the CLI (run from any working
 * directory via tsx) and `mastra dev` (which runs the bundle) read and write the
 * same file — a cwd-relative path would silently fork into separate databases, and
 * a path under `src/` would be swept into the bundle as a static asset.
 *
 * This module sits two levels below the root both as source (`src/mastra/`) and as
 * the bundle `mastra dev` executes (`.mastra/output/`), so `../..` resolves to the
 * root in both layouts. `moduleDir` and `override` are injectable so the resolution
 * is unit-testable without touching the process environment or the real module path.
 *
 * @param moduleDir the directory of this module (`src/mastra` or `.mastra/output`)
 * @param override an explicit URL (e.g. `INTERVIEW_COACH_DB_URL`); empty is ignored
 */
export function resolveDbUrl(moduleDir: string, override?: string): string {
  if (override) return override;
  return `file:${join(moduleDir, '..', '..', 'data', 'mastra.db')}`;
}

/**
 * The one resolved database URL for this process. Exported so sibling stores (e.g.
 * the RAG vector index) can anchor their own file beside `mastra.db` in the same
 * `./data/` directory rather than re-deriving the project root.
 */
export const dbUrl = resolveDbUrl(
  dirname(fileURLToPath(import.meta.url)),
  process.env.INTERVIEW_COACH_DB_URL,
);

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
