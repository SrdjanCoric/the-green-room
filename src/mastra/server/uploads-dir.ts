import { dirname, join } from 'node:path';

import { dbUrl } from '../storage';

/**
 * The directory browser-uploaded CVs are written into, beside the shared `./data`
 * database. This is also the allowed base directory the interview workflow confines a
 * client-supplied `cvPath` to, so a run started over the server can only read a CV the
 * upload route actually wrote — never an arbitrary file on the host.
 */
export const uploadsDir = dbUrl.startsWith('file:')
  ? join(dirname(dbUrl.slice('file:'.length)), 'uploads')
  : join(process.cwd(), 'data', 'uploads');
