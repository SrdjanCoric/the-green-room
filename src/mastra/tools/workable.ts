import { htmlToText } from './html-to-text';
import { asString, isRecord } from './loose-json';

/**
 * Workable adapter: Workable renders postings client-side, so its hosted URLs carry
 * little text. These helpers map a hosted URL to the public JSON widget endpoint and
 * turn the widget's response into posting text.
 */

const WORKABLE_HOST_RE = /(^|\.)workable\.com$/i;

export interface WorkableTarget {
  apiUrl: string;
  shortcode: string | null;
}

/**
 * Map a Workable-hosted posting URL to its public, unauthenticated JSON endpoint,
 * or return null if the URL isn't a Workable board. Hosted URLs take two shapes —
 * `apply.workable.com/<account>/j/<SHORTCODE>` and `<account>.workable.com/j|jobs/<SHORTCODE>`
 * — both served by the account widget endpoint; the shortcode narrows to one job.
 */
export function workableApiUrl(rawUrl: string): WorkableTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!WORKABLE_HOST_RE.test(url.hostname)) return null;

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  let account: string | null = null;
  let shortcode: string | null = null;

  if (host === 'apply.workable.com') {
    account = segments[0] ?? null;
    const jIndex = segments.indexOf('j');
    if (jIndex >= 0) shortcode = segments[jIndex + 1] ?? null;
  } else {
    account = host.slice(0, host.length - '.workable.com'.length) || null;
    const key = segments.includes('j') ? 'j' : segments.includes('jobs') ? 'jobs' : null;
    if (key) shortcode = segments[segments.indexOf(key) + 1] ?? null;
  }

  if (!account) return null;
  const apiUrl = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(
    account,
  )}?details=true`;
  return { apiUrl, shortcode };
}

export function parseWorkableJob(body: string, shortcode: string | null): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Workable API did not return JSON.');
  }
  const jobs = extractWorkableJobs(parsed);
  if (jobs.length === 0) {
    throw new Error('Workable API returned no jobs.');
  }
  // With a shortcode, return that job or fail — never silently substitute a different
  // posting (a stale/closed shortcode would otherwise build the interview for the
  // wrong role). Without one, fall back to the first job.
  if (shortcode) {
    const match = jobs.find(
      (candidate) => asString(candidate.shortcode)?.toLowerCase() === shortcode.toLowerCase(),
    );
    if (!match) {
      throw new Error(`Workable job "${shortcode}" was not found among the account's published jobs.`);
    }
    return workableJobToText(match);
  }
  return workableJobToText(jobs[0]);
}

function extractWorkableJobs(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (isRecord(parsed) && Array.isArray(parsed.jobs)) return parsed.jobs.filter(isRecord);
  if (isRecord(parsed)) return [parsed];
  return [];
}

function workableJobToText(job: Record<string, unknown>): string {
  const lines: string[] = [];
  const title = asString(job.title);
  if (title) lines.push(`Role: ${title}`);

  const company = asString(job.company) ?? asString(isRecord(job.account) ? job.account.name : undefined);
  if (company) lines.push(`Company: ${company}`);

  const location = asString(job.location) ?? asString(job.city) ?? asString(job.country);
  if (location) lines.push(`Location: ${location}`);

  const body = [job.description, job.requirements, job.benefits]
    .map((part) => asString(part))
    .filter((part): part is string => part !== undefined);
  if (body.length > 0) lines.push('', htmlToText(body.join('\n\n')));

  return lines.join('\n').trim();
}
