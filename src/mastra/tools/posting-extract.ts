import { htmlToText } from './html-to-text';
import { asString, isRecord } from './loose-json';

/**
 * Posting-content extraction: prefer structured `JobPosting` data (a JSON body or an
 * embedded ld+json block) over raw page text, falling back to stripped HTML.
 */

/** How the posting text was obtained, for observability and tests. */
export type PostingSource = 'ld+json' | 'workable' | 'html';

export function extractPosting(
  body: string,
  contentType: string,
): { text: string; source: PostingSource } {
  // Some boards serve JobPosting JSON directly at the posting URL.
  if (contentType.includes('json')) {
    const fromJson = jobPostingFromJson(body);
    if (fromJson) return { text: fromJson, source: 'ld+json' };
  }
  const fromLdJson = extractLdJsonJobPosting(body);
  if (fromLdJson) return { text: fromLdJson, source: 'ld+json' };
  return { text: htmlToText(body), source: 'html' };
}

const LD_JSON_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function extractLdJsonJobPosting(html: string): string | null {
  for (const match of html.matchAll(LD_JSON_RE)) {
    const block = match[1];
    if (!block) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      continue;
    }
    const posting = findJobPosting(parsed);
    if (posting) {
      const text = jobPostingToText(posting);
      if (text) return text;
    }
  }
  return null;
}

function jobPostingFromJson(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const posting = findJobPosting(parsed);
  return posting ? jobPostingToText(posting) : null;
}

/** Walk an ld+json value (object, array, or `@graph`) for the first `JobPosting`. */
function findJobPosting(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(node)) {
    const type = node['@type'];
    if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) {
      return node;
    }
    if ('@graph' in node) return findJobPosting(node['@graph']);
  }
  return null;
}

function jobPostingToText(posting: Record<string, unknown>): string {
  const lines: string[] = [];
  const title = asString(posting.title);
  if (title) lines.push(`Role: ${title}`);

  const org = posting.hiringOrganization;
  const orgName = typeof org === 'string' ? org : asString(isRecord(org) ? org.name : undefined);
  if (orgName) lines.push(`Company: ${orgName}`);

  const employmentType = asString(posting.employmentType);
  if (employmentType) lines.push(`Employment type: ${employmentType}`);

  const location = jobLocationText(posting.jobLocation);
  if (location) lines.push(`Location: ${location}`);

  const description = asString(posting.description);
  if (description) lines.push('', htmlToText(description));

  return lines.join('\n').trim();
}

function jobLocationText(location: unknown): string | undefined {
  const place: unknown = Array.isArray(location) ? location[0] : location;
  if (!isRecord(place)) return undefined;
  const address = place.address;
  if (typeof address === 'string') return address;
  if (isRecord(address)) {
    const parts = [address.addressLocality, address.addressRegion, address.addressCountry]
      .map((part) => asString(part))
      .filter((part): part is string => part !== undefined);
    if (parts.length > 0) return parts.join(', ');
  }
  return undefined;
}
