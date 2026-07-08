import { join } from 'node:path';

import { dataDir } from '../data-dir';

/**
 * The directory browser-uploaded CVs are written into, inside the shared `data/`
 * directory (so `INTERVIEW_COACH_DATA_DIR` relocates it together with the reports and
 * the last-run pointer). This is also the allowed base directory the interview
 * workflow confines a client-supplied `cvPath` to, so a run started over the server
 * can only read a CV the upload route actually wrote — never an arbitrary file on
 * the host.
 */
export const uploadsDir = join(dataDir, 'uploads');
