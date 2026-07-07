import { randomUUID } from 'node:crypto';

import type { CandidateProfile } from '../mastra/schemas/candidate-profile';
import type { CompanyBrief } from '../mastra/schemas/company-brief';
import type { TranscriptEntry } from '../mastra/schemas/interview';
import type { RoleContext } from '../mastra/schemas/role-context';
import { capPostingText } from '../mastra/tools/fetch-posting';
import {
  PostingFetchError,
  resolvePosting,
  type ResolvePostingOptions,
} from '../mastra/tools/resolve-posting';

export interface ResolveJobPostingOptions {
  /** The raw `--job` argument: a URL, a file path, or pasted text. */
  job?: string;
  /**
   * Called when a URL fetch fails, to offer the paste fallback. Returns the pasted
   * posting text, or null to proceed without a posting (a broken link never blocks
   * the interview).
   */
  onFetchFailure?: (url: string) => Promise<string | null>;
  /** Injected resolver options, for tests. */
  resolveOptions?: ResolvePostingOptions;
}

export interface ResolvedJobPostingInput {
  postingText?: string;
  researchUrls: string[];
}

/**
 * Resolve the `--job` argument into posting text. A URL is fetched, a file is read,
 * and anything else is treated as pasted text. When a URL fetch fails and an
 * `onFetchFailure` handler is given, it is offered the chance to paste the posting;
 * declining (or no posting at all) yields `undefined`, so the run falls back to a
 * generic interview rather than failing.
 */
export async function resolveJobPosting(
  options: ResolveJobPostingOptions,
): Promise<ResolvedJobPostingInput> {
  const job = options.job?.trim();
  if (!job) return { postingText: undefined, researchUrls: [] };

  try {
    const resolved = await resolvePosting(job, options.resolveOptions);
    return { postingText: resolved.text, researchUrls: resolved.url ? [resolved.url] : [] };
  } catch (error) {
    if (error instanceof PostingFetchError && options.onFetchFailure) {
      const pasted = await options.onFetchFailure(error.url);
      const trimmed = pasted?.trim();
      // Cap the pasted text to the same limit as every other resolution path.
      return {
        postingText: trimmed && trimmed.length > 0 ? capPostingText(trimmed) : undefined,
        researchUrls: [],
      };
    }
    throw error;
  }
}

/**
 * Resolve the candidate (`resourceId`) and session (`threadId`) ids for a run.
 * Both default to a fresh id: because working memory is resource-scoped, a shared
 * default would let one candidate's ingest overwrite another's. Pass `--candidate`
 * to pin a stable id across runs (e.g. to resume a session later).
 */
export function resolveIngestIds(options: {
  resourceId?: string;
  threadId?: string;
}): { resourceId: string; threadId: string } {
  return {
    resourceId: options.resourceId ?? randomUUID(),
    threadId: options.threadId ?? randomUUID(),
  };
}

/** Render a candidate profile as a readable multi-line summary for the CLI. */
export function formatCandidateProfile(profile: CandidateProfile): string {
  const lines: string[] = [];

  if (profile.name) lines.push(profile.name);
  if (profile.headline) lines.push(profile.headline);
  if (profile.yearsExperience !== undefined) {
    lines.push(`Experience: ${profile.yearsExperience} years`);
  }

  if (profile.roles.length > 0) {
    lines.push('', 'Roles:');
    for (const role of profile.roles) {
      const company = role.company ? ` @ ${role.company}` : '';
      lines.push(`  • ${role.title}${company}`);
    }
  }

  if (profile.projects.length > 0) {
    lines.push('', 'Projects:');
    for (const project of profile.projects) {
      lines.push(`  • ${project.name}`);
    }
  }

  if (profile.quantifiedClaims.length > 0) {
    lines.push('', 'Quantified claims:');
    for (const claim of profile.quantifiedClaims) {
      lines.push(`  • ${claim}`);
    }
  }

  if (profile.technologies.length > 0) {
    lines.push('', `Technologies: ${profile.technologies.join(', ')}`);
  }

  return lines.length > 0 ? lines.join('\n') : 'No profile fields were extracted from the CV.';
}

/** Render a role context as a readable multi-line summary for the CLI. */
export function formatRoleContext(role: RoleContext): string {
  const lines: string[] = [role.company ? `${role.role} @ ${role.company}` : role.role];

  if (role.seniority) lines.push(`Seniority: ${role.seniority}`);
  if (role.summary) lines.push('', role.summary);

  if (role.competencies.length > 0) {
    lines.push('', 'Competencies (weighted):');
    for (const competency of role.competencies) {
      lines.push(`  • ${competency.name} (${competency.weight.toFixed(2)})`);
    }
  }

  if (role.valuesFramework.length > 0) {
    lines.push('', `Values: ${role.valuesFramework.join(', ')}`);
  }

  return lines.join('\n');
}

/** Render a company research brief as a readable multi-line summary for the CLI. */
export function formatCompanyBrief(brief: CompanyBrief): string {
  const hasSummary = brief.summary.trim().length > 0;
  const hasFacts = brief.facts.length > 0;
  const hasSources = brief.sources.length > 0;
  if (!brief.company && !hasSummary && !hasFacts && !hasSources) {
    return 'No company brief is available.';
  }

  const lines: string[] = [];
  if (brief.company) lines.push(brief.company);
  if (hasSummary) lines.push('', brief.summary);

  if (hasFacts) {
    lines.push('', 'Facts:');
    for (const fact of brief.facts) {
      lines.push(`  • ${fact}`);
    }
  }

  if (hasSources) {
    lines.push('', 'Sources:');
    for (const source of brief.sources) {
      lines.push(`  • ${source}`);
    }
  }

  return lines.join('\n').trim();
}

/** Render the interview transcript as a readable Q/A summary for the CLI. */
export function formatTranscript(transcript: TranscriptEntry[]): string {
  if (transcript.length === 0) return 'No questions were asked.';

  const lines: string[] = [];
  transcript.forEach((entry, index) => {
    if (index > 0) lines.push('');
    lines.push(`Q${index + 1}: ${entry.question}`);
    lines.push(`A${index + 1}: ${entry.answer}`);
  });
  return lines.join('\n');
}
