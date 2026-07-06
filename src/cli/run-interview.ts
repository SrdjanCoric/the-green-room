import { randomUUID } from 'node:crypto';

import { mastra } from '../mastra/index';
import {
  buildModelRequestContext,
  resolveModelTiers,
  type ModelTierOptions,
} from '../mastra/model-config';
import type { CandidateProfile } from '../mastra/schemas/candidate-profile';

export interface IngestCvOptions extends ModelTierOptions {
  /** Path to the CV file (.pdf, .txt, or .md). */
  cvPath: string;
  /** Stable candidate id; keys resource-scoped working memory. Defaults to a fresh id. */
  resourceId?: string;
  /** Interview session id. Defaults to a fresh id per run. */
  threadId?: string;
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

/**
 * Drive the interview workflow's `ingest` step in-process — the same
 * `createRun` → `start` path a remote client would use over the Mastra server —
 * resolving the model tiers from the given options and injecting them via the
 * request context. Returns the parsed candidate profile.
 */
export async function ingestCv(options: IngestCvOptions): Promise<CandidateProfile> {
  const tiers = resolveModelTiers(options);
  const requestContext = buildModelRequestContext(tiers);
  const { resourceId, threadId } = resolveIngestIds(options);

  const workflow = mastra.getWorkflow('interviewWorkflow');
  const run = await workflow.createRun();
  const result = await run.start({
    inputData: { cvPath: options.cvPath, resourceId, threadId },
    requestContext,
  });

  if (result.status !== 'success') {
    // Surface the real cause (bad path, unsupported type, schema/model error)
    // rather than collapsing every failure into one opaque message. The workflow
    // serializes the step error through storage, so it arrives as a plain
    // `{ message }` object, not an `Error` instance.
    const cause = result.status === 'failed' ? result.error : undefined;
    const detail = errorMessageOf(cause) ?? `status: ${result.status}`;
    throw new Error(`Interview ingest failed — ${detail}`, cause ? { cause } : undefined);
  }

  return result.result.profile;
}

/** Pull a human message out of a workflow error, whether an `Error` or a serialized `{ message }`. */
function errorMessageOf(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === 'object' && 'message' in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return undefined;
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
