import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';

import { extractCvText } from '../tools/extract-cv';
import { candidateMemory } from '../memory';
import {
  candidateProfileSchema,
  type CandidateProfile,
} from '../schemas/candidate-profile';

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
  updateWorkingMemory(args: {
    threadId: string;
    resourceId?: string;
    workingMemory: string;
  }): Promise<void>;
}

/**
 * The precise slice of an agent's `generate` this step calls: structured output
 * against the profile schema, driven by the run's request context. Typing the
 * options concretely (rather than `unknown`) means a wrong `structuredOutput`
 * shape or a renamed option is caught at the call site; the real Mastra `Agent`
 * satisfies it structurally.
 */
export interface StructuredProfileGenerator {
  generate(
    prompt: string,
    options: {
      structuredOutput: { schema: typeof candidateProfileSchema };
      requestContext: RequestContext;
    },
  ): Promise<{ object?: CandidateProfile }>;
}

/** Build the parsing prompt fed to the CV-parser agent. */
export function buildCvParsePrompt(cvText: string): string {
  return `Extract the candidate profile from this CV.\n\n---\n${cvText}\n---`;
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
 * Returns the schema-complete profile (array fields defaulted). Throws if the
 * extraction does not satisfy the schema, so working memory only ever holds a
 * valid profile.
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
  await memory.updateWorkingMemory({
    resourceId,
    threadId,
    workingMemory: JSON.stringify(profile),
  });

  return profile;
}

/** Real extractor: run the CV-parser agent with structured output on the fast tier. */
export function createAgentExtractor(
  agent: StructuredProfileGenerator,
  requestContext: RequestContext,
): ProfileExtractor {
  return async (cvText) => {
    const result = await agent.generate(buildCvParsePrompt(cvText), {
      structuredOutput: { schema: candidateProfileSchema },
      requestContext,
    });
    if (!result.object) {
      throw new Error('CV parser returned no structured profile.');
    }
    return result.object;
  };
}

const ingestInputSchema = z.object({
  // `cvPath` is a local filesystem path read directly by the ingest step. In the
  // CLI it is the operator's own trusted input. If this workflow is ever exposed
  // over the Mastra server (task 0011), that path becomes attacker-controlled and
  // must be confined to an allowed base directory, or the CV bytes uploaded
  // instead of a server-side path.
  cvPath: z.string().describe('Path to the candidate CV file (.pdf, .txt, or .md).'),
  resourceId: z.string().describe('Stable id for the candidate; keys resource-scoped memory.'),
  threadId: z.string().describe('Id for this interview session.'),
});

const ingestOutputSchema = z.object({
  profile: candidateProfileSchema,
});

/**
 * `ingest`: read the CV, parse it into a structured profile with the CV-parser
 * agent, and write that profile into the candidate's working memory. The first
 * step of the interview workflow.
 */
export const ingestStep = createStep({
  id: 'ingest',
  inputSchema: ingestInputSchema,
  outputSchema: ingestOutputSchema,
  execute: async ({ inputData, mastra, requestContext }) => {
    const cvText = await extractCvText(inputData.cvPath);
    const agent = mastra.getAgent('cvParser');
    const profile = await persistCandidateProfile({
      extractor: createAgentExtractor(agent, requestContext),
      cvText,
      memory: candidateMemory,
      resourceId: inputData.resourceId,
      threadId: inputData.threadId,
    });
    return { profile };
  },
});

/**
 * The interview workflow. Task 0002 wires only its first step, `ingest`; later
 * tasks extend it with research, the adaptive interview loop, grading, and
 * coaching, on the same run so its snapshot carries the whole session.
 */
export const interviewWorkflow = createWorkflow({
  id: 'interviewWorkflow',
  inputSchema: ingestInputSchema,
  outputSchema: ingestOutputSchema,
})
  .then(ingestStep)
  .commit();
