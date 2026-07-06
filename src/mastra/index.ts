import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { PinoLogger } from '@mastra/loggers';
import { MastraStorageExporter, Observability } from '@mastra/observability';

import { pingWorkflow } from './workflows/ping-workflow';

// Anchor the database to the project root so every entrypoint — the CLI (run
// from any working directory) and `mastra dev` — reads and writes the same file.
// A cwd-relative path would silently diverge into separate databases.
//
// This module sits two levels below the root both as source (`src/mastra/`, run
// via tsx) and as the bundle `mastra dev` executes (`.mastra/output/`), so
// `../..` resolves to the root in both cases. If a future Mastra layout breaks
// that assumption, set INTERVIEW_COACH_DB_URL to an explicit path — the same
// override tests use to select an in-memory database.
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dbUrl = process.env.INTERVIEW_COACH_DB_URL ?? `file:${join(projectRoot, 'data', 'mastra.db')}`;

// LibSQL opens file-backed databases eagerly, so make sure the directory exists
// first. In-memory databases (used by tests) have no directory to create.
if (dbUrl.startsWith('file:')) {
  mkdirSync(dirname(dbUrl.slice('file:'.length)), { recursive: true });
}

/**
 * A single LibSQL store backs workflow snapshots, memory, and scorer results.
 * The default file lives under `./data/` (gitignored) and is shared with
 * `mastra dev`, so Studio reads the same database this process writes to.
 */
const storage = new LibSQLStore({
  id: 'interview-coach',
  url: dbUrl,
});

/**
 * Native observability. The `MastraStorageExporter` persists AI traces into the
 * configured storage, which surfaces every run as a trace in Studio. (LibSQL
 * logs a benign warning that it does not batch-create metrics; traces are
 * unaffected.)
 */
const observability = new Observability({
  configs: {
    default: {
      serviceName: 'interview-coach',
      exporters: [new MastraStorageExporter()],
    },
  },
});

export const mastra = new Mastra({
  workflows: { pingWorkflow },
  storage,
  observability,
  logger: new PinoLogger({ name: 'interview-coach', level: 'info' }),
});
