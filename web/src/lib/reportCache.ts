import { interviewReportViewSchema } from '../../../shared/wire-contract';

import { safeSetItem } from './storage';
import type { InterviewReport } from './types';

const REPORT_PREFIX = 'green-room:report:';

/**
 * Cache a finished report so a reload (or a playbill click) can reopen it without
 * re-running the workflow. The write is guarded: a full quota only loses the cache,
 * never crashes the stream-completion path that calls this.
 */
export function cacheReport(storage: Storage, runId: string, report: InterviewReport): void {
  safeSetItem(storage, `${REPORT_PREFIX}${runId}`, JSON.stringify(report));
}

/**
 * Read a cached report, validated against the shared report schema. Absent, corrupt, or
 * stale-shape data (an old schema, a truncated write) returns `null`, so the caller
 * falls back cleanly rather than rendering an ill-formed report.
 */
export function loadCachedReport(storage: Storage, runId: string): InterviewReport | null {
  const raw = storage.getItem(`${REPORT_PREFIX}${runId}`);
  if (!raw) return null;
  try {
    const parsed = interviewReportViewSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
