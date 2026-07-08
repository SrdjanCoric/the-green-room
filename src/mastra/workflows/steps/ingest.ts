import { createStep } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';

import { assertCvPathAllowed, CV_PATH_TRUST_ENV } from '../../server/cv-path-guard';
import { uploadsDir } from '../../server/uploads-dir';
import { extractCvText } from '../../tools/extract-cv';
import { parseCandidateWorkingMemory } from '../../interview/coaching-ledger';
import { candidateMemory } from '../../memory';
import { neutralizeFences } from '../../prompt-safety';
import { structuredCall, type StructuredGenerator } from '../../structured-call';
import { candidateProfileSchema, type CandidateProfile } from '../../schemas/candidate-profile';
import {
  DEFAULT_ROLE_CONTEXT,
  roleContextSchema,
  type RoleContext,
} from '../../schemas/role-context';
import { ingestInputSchema, ingestOutputSchema } from '../interview-state';

/**
 * The model boundary for CV parsing, injected so it can be mocked in tests: given
 * CV text, produce a raw (as-yet-unvalidated) profile object. In production this is
 * backed by the CV-parser agent; the returned value is validated before use.
 */
export type ProfileExtractor = (cvText: string) => Promise<unknown>;

/** The subset of the memory API the ingest step depends on. */
export interface CandidateProfileStore {
  getThreadById(args: { threadId: string; resourceId?: string }): Promise<{ id: string } | null>;
  saveThread(args: {
    thread: { id: string; title: string; resourceId: string; createdAt: Date; updatedAt: Date };
  }): Promise<unknown>;
  getWorkingMemory(args: { threadId: string; resourceId?: string }): Promise<string | null>;
  updateWorkingMemory(args: {
    threadId: string;
    resourceId?: string;
    workingMemory: string;
  }): Promise<void>;
}

/** Where a run's candidate id came from, in precedence order. */
export type CandidateIdOrigin = 'flag' | 'cv' | 'default';

/** The first email-shaped token in a text, if any. */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Resolve the candidate's stable identity for resource-scoped memory, in strict
 * precedence: an explicit override (the `--candidate` flag) wins; otherwise the first
 * email address in the raw CV text (deterministic — trimmed and lowercased, never
 * LLM-extracted, because identity must be stable across runs); otherwise the literal
 * `'default'`. Computed right after CV text extraction and carried in workflow state.
 *
 * Trust boundary: every input here is client-controlled, so whoever supplies the
 * `candidate` value (or a CV embedding an email) reads and writes that candidate's
 * profile and coaching ledger. That is by design for the single-operator local setup;
 * a multi-tenant deployment must bind runs to a server-issued candidate id instead
 * (the way `cvPath` is confined to the uploads directory).
 */
export function resolveCandidateIdentity(params: {
  override?: string;
  cvText: string;
}): { candidateId: string; candidateIdOrigin: CandidateIdOrigin } {
  const override = params.override?.trim();
  if (override) return { candidateId: override, candidateIdOrigin: 'flag' };

  const email = EMAIL_PATTERN.exec(params.cvText)?.[0];
  if (email) return { candidateId: email.trim().toLowerCase(), candidateIdOrigin: 'cv' };

  return { candidateId: 'default', candidateIdOrigin: 'default' };
}

/** Build the parsing prompt fed to the CV-parser agent, fencing the untrusted CV. */
export function buildCvParsePrompt(cvText: string): string {
  return `Extract the candidate profile from the CV between the <cv> tags.\n<cv>\n${neutralizeFences(
    cvText,
  )}\n</cv>`;
}

/** A string field counts as present only if it holds non-whitespace text. */
function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** True when the parser produced nothing usable — no scalar fields and every list empty. */
function isProfileEmpty(profile: CandidateProfile): boolean {
  return (
    !hasText(profile.name) &&
    !hasText(profile.headline) &&
    profile.yearsExperience === undefined &&
    profile.roles.length === 0 &&
    profile.projects.length === 0 &&
    profile.quantifiedClaims.length === 0 &&
    profile.technologies.length === 0
  );
}

/** Ensure a thread row exists so resource-scoped working memory has somewhere to attach. */
async function ensureThread(
  memory: CandidateProfileStore,
  resourceId: string,
  threadId: string,
): Promise<void> {
  const existing = await memory.getThreadById({ threadId, resourceId });
  if (!existing) {
    const now = new Date();
    await memory.saveThread({
      thread: { id: threadId, title: 'Interview session', resourceId, createdAt: now, updatedAt: now },
    });
  }
}

/**
 * Validate the extractor's output against the profile schema and persist it to
 * working memory, keyed by the candidate (`resourceId`) and session (`threadId`).
 * Working memory holds `{ profile, sessions }`; a re-ingest refreshes the profile
 * and preserves the candidate's existing session ledger, so a returning candidate
 * never loses their coaching history to a new interview. Returns the
 * schema-complete profile (array fields defaulted). Throws if the extraction does
 * not satisfy the schema, so working memory only ever holds a valid record.
 */
export async function persistCandidateProfile(params: {
  extractor: ProfileExtractor;
  cvText: string;
  memory: CandidateProfileStore;
  resourceId: string;
  threadId: string;
}): Promise<CandidateProfile> {
  const { extractor, cvText, memory, resourceId, threadId } = params;

  const raw = await extractor(cvText);
  const profile = candidateProfileSchema.parse(raw);

  if (isProfileEmpty(profile)) {
    throw new Error('CV parsing produced no profile fields — the CV text may be empty or unreadable.');
  }

  await ensureThread(memory, resourceId, threadId);
  const existing = parseCandidateWorkingMemory(
    await memory.getWorkingMemory({ resourceId, threadId }),
  );
  await memory.updateWorkingMemory({
    resourceId,
    threadId,
    workingMemory: JSON.stringify({ profile, sessions: existing?.sessions ?? [] }),
  });

  return profile;
}

/** Real extractor: run the CV-parser agent with structured output on the fast tier. */
export function createAgentExtractor(
  agent: StructuredGenerator,
  requestContext: RequestContext,
): ProfileExtractor {
  return async (cvText) =>
    structuredCall(agent, buildCvParsePrompt(cvText), candidateProfileSchema, requestContext, {
      description: 'CV parser',
    });
}

/** Build the prompt fed to the role-builder agent, fencing the untrusted posting. */
export function buildRoleContextPrompt(postingText: string): string {
  return `Derive the role context from the job posting between the <posting> tags.\n<posting>\n${neutralizeFences(
    postingText,
  )}\n</posting>`;
}

/** Turn resolved posting text into a role context via the role-builder agent. */
export type RoleContextBuilder = (postingText: string) => Promise<RoleContext>;

/** Real builder: run the role-builder agent with structured output on the fast tier. */
export function createRoleContextBuilder(
  agent: StructuredGenerator,
  requestContext: RequestContext,
): RoleContextBuilder {
  return async (postingText) =>
    structuredCall(agent, buildRoleContextPrompt(postingText), roleContextSchema, requestContext, {
      description: 'role builder',
    });
}

/**
 * Resolve the role context for a run: when a posting was provided, derive it with the
 * role-builder (validated against the schema); otherwise fall back to a generic
 * default so the interview proceeds even without a job posting.
 */
export async function buildRoleContext(params: {
  builder: RoleContextBuilder;
  postingText?: string;
}): Promise<RoleContext> {
  const text = params.postingText?.trim();
  if (!text) return DEFAULT_ROLE_CONTEXT;
  return roleContextSchema.parse(await params.builder(text));
}

/**
 * `ingest`: read the CV into a structured profile (written to the candidate's working
 * memory) and derive the role context from the resolved job posting, falling back to a
 * generic role context when no posting was provided. The first step of the interview
 * workflow.
 */
export const ingestStep = createStep({
  id: 'ingest',
  inputSchema: ingestInputSchema,
  outputSchema: ingestOutputSchema,
  execute: async ({ inputData, mastra, requestContext }) => {
    // Over the Mastra server `cvPath` is client-controlled, so confine it to the
    // upload directory unless a trusted process (the CLI) opts out. Without this the
    // ingest step would read any file on the host — see the `ingestInputSchema` note.
    assertCvPathAllowed(inputData.cvPath, {
      uploadsDir,
      trustLocalPaths: process.env[CV_PATH_TRUST_ENV] === '1',
    });
    const cvText = await extractCvText(inputData.cvPath);
    const { candidateId, candidateIdOrigin } = resolveCandidateIdentity({
      override: inputData.candidate,
      cvText,
    });
    const profile = await persistCandidateProfile({
      extractor: createAgentExtractor(mastra.getAgent('cvParser'), requestContext),
      cvText,
      memory: candidateMemory,
      resourceId: candidateId,
      threadId: inputData.threadId,
    });

    const roleContext = await buildRoleContext({
      builder: createRoleContextBuilder(mastra.getAgent('roleBuilder'), requestContext),
      postingText: inputData.postingText,
    });

    return {
      profile,
      roleContext,
      candidateId,
      candidateIdOrigin,
      threadId: inputData.threadId,
      researchUrls: inputData.researchUrls,
      targetLevel: inputData.targetLevel,
      limits: inputData.limits,
    };
  },
});
