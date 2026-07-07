import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the one canonical `data/` directory every entrypoint must share.
 *
 * Like the database (see `storage.ts`), the app's durable files — the last-run
 * pointer and the coaching reports — are anchored to the project root so the CLI
 * (run from any working directory via tsx) and `mastra dev` (which runs the bundle)
 * read and write the same files; a cwd-relative path would silently fork them.
 *
 * This module sits two levels below the root both as source (`src/mastra/`) and as
 * the bundle `mastra dev` executes (`.mastra/output/`), so `../..` resolves to the
 * root in both layouts. `moduleDir` is injectable so the resolution is unit-testable.
 */
export function resolveDataDir(moduleDir: string): string {
  return join(moduleDir, '..', '..', 'data');
}

/** The one resolved `data/` directory for this process. */
export const dataDir = resolveDataDir(dirname(fileURLToPath(import.meta.url)));
