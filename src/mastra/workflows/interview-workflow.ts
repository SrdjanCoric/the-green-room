import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';

import { extractCvText } from '../tools/extract-cv';
import { candidateMemory } from '../memory';
import {
  candidateProfileSchema,
  type CandidateProfile,
} from '../schemas/candidate-profile';
import {
  EMPTY_COMPANY_BRIEF,
  companyBriefSchema,
  type CompanyBrief,
} from '../schemas/company-brief';
import {
  transcriptEntrySchema,
  type TranscriptEntry,
} from '../schemas/interview';
import {
  DEFAULT_ROLE_CONTEXT,
  roleContextSchema,
  type RoleContext,
} from '../schemas/role-context';
import {
  DEFAULT_CAP_LIMITS,
  INITIAL_COVERAGE,
  allowQuestion,
  capLimitsSchema,
  coverageStateSchema,
  type CapLimits,
  type CoverageState,
} from './interview-caps';

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

/**
 * The slice of the role-builder agent's `generate` the ingest step calls: structured
 * output against the role-context schema, driven by the run's request context. Typed
 * concretely so a wrong `structuredOutput` shape is caught at the call site; the real
 * Mastra `Agent` satisfies it structurally.
 */
export interface StructuredRoleContextGenerator {
  generate(
    prompt: string,
    options: {
      structuredOutput: { schema: typeof roleContextSchema };
      requestContext: RequestContext;
    },
  ): Promise<{ object?: RoleContext }>;
}

/** Build the prompt fed to the role-builder agent. */
export function buildRoleContextPrompt(postingText: string): string {
  return `Derive the role context from this job posting.\n\n---\n${postingText}\n---`;
}

/** Turn resolved posting text into a role context via the role-builder agent. */
export type RoleContextBuilder = (postingText: string) => Promise<RoleContext>;

/** Real builder: run the role-builder agent with structured output on the fast tier. */
export function createRoleContextBuilder(
  agent: StructuredRoleContextGenerator,
  requestContext: RequestContext,
): RoleContextBuilder {
  return async (postingText) => {
    const result = await agent.generate(buildRoleContextPrompt(postingText), {
      structuredOutput: { schema: roleContextSchema },
      requestContext,
    });
    if (!result.object) {
      throw new Error('Role builder returned no structured role context.');
    }
    return result.object;
  };
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

export const RESEARCH_FETCH_BUDGET = 3;

export interface StructuredResearchBriefGenerator {
  generate(
    prompt: string,
    options: {
      structuredOutput: { schema: typeof companyBriefSchema };
      requestContext: RequestContext;
      maxSteps: number;
      hooks: {
        beforeToolCall: (context: { toolName: string }) =>
          | void
          | {
              proceed: false;
              output: { text: string; url: string };
            };
      };
    },
  ): Promise<{ object?: CompanyBrief }>;
}

export interface ResearchBriefInput {
  roleContext: RoleContext;
  researchUrls: string[];
}

export type CompanyBriefBuilder = (input: ResearchBriefInput) => Promise<CompanyBrief>;

export function buildResearchPrompt(input: ResearchBriefInput): string {
  const role = input.roleContext;
  const companyLine = role.company ? `Company: ${role.company}` : 'Company: unknown';
  const urls =
    input.researchUrls.length > 0
      ? input.researchUrls.map((url) => `- ${url}`).join('\n')
      : '- none provided';
  return `Write a short public company brief for a behavioral interview.

${companyLine}
Role: ${role.role}
${role.summary ? `Role context: ${role.summary}` : ''}
Allowed public research URLs:
${urls}

Use the fetchResearchPage tool for public company pages only when the prompt or role context gives you a public URL. Do not guess URLs. Use at most ${RESEARCH_FETCH_BUDGET} fetches. If you cannot find public context, return an empty summary, facts, and sources.`;
}

export function createResearchFetchBudgetHooks(maxFetches: number = RESEARCH_FETCH_BUDGET): {
  beforeToolCall: (context: { toolName: string }) =>
    | void
    | {
        proceed: false;
        output: { text: string; url: string };
      };
} {
  let fetches = 0;
  return {
    beforeToolCall: ({ toolName }) => {
      if (toolName !== 'fetchResearchPage') return;
      if (fetches >= maxFetches) {
        return {
          proceed: false,
          output: { text: 'Research fetch budget exhausted; no page was fetched.', url: '' },
        };
      }
      fetches += 1;
    },
  };
}

export function createResearchBriefBuilder(
  agent: StructuredResearchBriefGenerator,
  requestContext: RequestContext,
): CompanyBriefBuilder {
  return async (input) => {
    const result = await agent.generate(buildResearchPrompt(input), {
      structuredOutput: { schema: companyBriefSchema },
      requestContext,
      maxSteps: RESEARCH_FETCH_BUDGET + 1,
      hooks: createResearchFetchBudgetHooks(),
    });
    if (!result.object) {
      throw new Error('Research agent returned no structured company brief.');
    }
    return result.object;
  };
}

export async function buildCompanyBrief(params: {
  builder: CompanyBriefBuilder;
  roleContext: RoleContext;
  researchUrls?: string[];
  timeoutMs?: number;
}): Promise<CompanyBrief> {
  try {
    const research = params.builder({
      roleContext: params.roleContext,
      researchUrls: params.researchUrls ?? [],
    });
    return companyBriefSchema.parse(await withTimeout(research, params.timeoutMs ?? 15_000));
  } catch {
    return EMPTY_COMPANY_BRIEF;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Company research timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}


/**
 * The placeholder question for a turn. The adaptive brain (task 0006) replaces this
 * with a director-driven, transcript-aware question; here it is a deterministic prompt
 * so the loop mechanics — suspend, resume, transcript append, caps — can be built and
 * tested on their own.
 */
export function placeholderQuestion(questionNumber: number): string {
  return `Question ${questionNumber}: tell me about a challenge you faced and how you handled it.`;
}

/**
 * A cheap, dependency-free token estimate (~4 characters per token). Good enough to
 * enforce a coarse token-budget cap without pulling in a tokenizer; the exact model
 * accounting lives in observability, not here.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The mutable slice of interview state the turn logic reads and advances. */
export interface InterviewTurnState {
  transcript: TranscriptEntry[];
  coverage: CoverageState;
  limits: CapLimits;
}

/**
 * Record one answered question: append it to the transcript and advance the coverage
 * counters (one more question asked, its question and answer tokens spent). Pure —
 * returns a new state and mutates nothing — so the loop step and its tests share it.
 * Placeholder turns in this task are always new questions, so the within-topic
 * counters reset; the director (task 0006) will drive follow-up/reprompt counting.
 */
export function recordTurn(
  state: InterviewTurnState,
  entry: TranscriptEntry,
): InterviewTurnState {
  const coverage: CoverageState = {
    ...state.coverage,
    questionCount: state.coverage.questionCount + 1,
    tokensUsed:
      state.coverage.tokensUsed + estimateTokens(entry.question) + estimateTokens(entry.answer),
    consecutiveFollowUps: 0,
    repromptCount: 0,
  };
  return { ...state, transcript: [...state.transcript, entry], coverage };
}

/** True once no further question is allowed under the caps — the loop should end. */
export function interviewComplete(state: InterviewTurnState): boolean {
  return !allowQuestion(state.coverage, state.limits, 'new').allowed;
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
  // Already-resolved posting text (from a URL, file, or paste). Resolution — and the
  // interactive paste fallback on a fetch failure — happens client-side before the
  // run starts, so the step only turns text into a role context. Omit for a generic
  // interview.
  postingText: z
    .string()
    .optional()
    .describe('Resolved job-posting text; omit to run a generic behavioral interview.'),
  researchUrls: z
    .array(z.string())
    .default([])
    .describe('Public URLs the research step may fetch for company context.'),
  targetLevel: z
    .string()
    .optional()
    .describe('Seniority level to calibrate the interview to; if omitted the loop asks for it.'),
  limits: capLimitsSchema
    .optional()
    .describe('Override the default coverage caps that bound the session.'),
});

const ingestOutputSchema = z.object({
  profile: candidateProfileSchema,
  roleContext: roleContextSchema,
  researchUrls: z.array(z.string()).default([]),
  targetLevel: z.string().optional(),
  limits: capLimitsSchema.optional(),
});

export const researchOutputSchema = ingestOutputSchema.extend({
  companyBrief: companyBriefSchema,
});

/**
 * The state threaded through the interview loop: the ingest/research output plus a
 * resolved target level, the running transcript, the coverage counters, the caps
 * bounding the session, and a `done` flag the loop condition reads to stop.
 */
export const interviewStateSchema = researchOutputSchema.extend({
  targetLevel: z.string().describe('The resolved seniority level the interview targets.'),
  transcript: z.array(transcriptEntrySchema).default([]),
  coverage: coverageStateSchema,
  limits: capLimitsSchema,
  done: z.boolean().default(false).describe('True once the caps end the interview loop.'),
});

export type InterviewState = z.infer<typeof interviewStateSchema>;

/** Suspend payload for the target-level prompt: what to ask, tagged for the client. */
const levelSuspendSchema = z.object({
  kind: z.literal('level'),
  prompt: z.string().describe('The question asking the operator for the target level.'),
});

/** Resume payload answering the target-level prompt. */
const levelResumeSchema = z.object({
  level: z.string().describe('The chosen seniority level.'),
});

/** Suspend payload for an interview turn: the question posed to the candidate. */
const questionSuspendSchema = z.object({
  kind: z.literal('question'),
  question: z.string().describe('The question posed to the candidate this turn.'),
  questionNumber: z.number().int().positive().describe('1-based index of this question.'),
});

/** Resume payload for an interview turn: the candidate's answer. */
const answerResumeSchema = z.object({
  answer: z.string().describe("The candidate's answer to the suspended question."),
});

/** The two things an interview run can suspend to ask for: a level, or an answer. */
export type InterviewSuspend =
  | z.infer<typeof levelSuspendSchema>
  | z.infer<typeof questionSuspendSchema>;

/** Narrow an arbitrary suspend payload to the interview union, or `undefined`. */
export function asInterviewSuspend(payload: unknown): InterviewSuspend | undefined {
  if (payload && typeof payload === 'object' && 'kind' in payload) {
    const kind = (payload as { kind: unknown }).kind;
    if (kind === 'level' || kind === 'question') return payload as InterviewSuspend;
  }
  return undefined;
}

/**
 * Pull the pending suspend payload out of a suspended run result. `result.suspendPayload`
 * is a map keyed by the suspended step id; this linear workflow suspends one step at a
 * time, so there is normally a single entry. Rather than assume that, return the first
 * value that narrows to the interview union — so an unrelated concurrent suspension (were
 * one ever added) can't shadow the interview prompt. (The workflow state reader, used on
 * reconnect, exposes the payload directly instead — pass that through `asInterviewSuspend`.)
 */
export function readSuspendPayload(
  suspendPayload: Record<string, unknown> | undefined,
): InterviewSuspend | undefined {
  for (const value of Object.values(suspendPayload ?? {})) {
    const payload = asInterviewSuspend(value);
    if (payload) return payload;
  }
  return undefined;
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
    const cvText = await extractCvText(inputData.cvPath);
    const profile = await persistCandidateProfile({
      extractor: createAgentExtractor(mastra.getAgent('cvParser'), requestContext),
      cvText,
      memory: candidateMemory,
      resourceId: inputData.resourceId,
      threadId: inputData.threadId,
    });

    const roleContext = await buildRoleContext({
      builder: createRoleContextBuilder(mastra.getAgent('roleBuilder'), requestContext),
      postingText: inputData.postingText,
    });

    return {
      profile,
      roleContext,
      researchUrls: inputData.researchUrls,
      targetLevel: inputData.targetLevel,
      limits: inputData.limits,
    };
  },
});

export const researchStep = createStep({
  id: 'research',
  inputSchema: ingestOutputSchema,
  outputSchema: researchOutputSchema,
  execute: async ({ inputData, mastra, requestContext }) => {
    const companyBrief = await buildCompanyBrief({
      builder: createResearchBriefBuilder(mastra.getAgent('research'), requestContext),
      roleContext: inputData.roleContext,
      researchUrls: inputData.researchUrls,
    });

    return { ...inputData, companyBrief };
  },
});

/**
 * `collectLevel`: resolve the target seniority level. If it arrived on the run input
 * (the `--level` flag) it passes straight through; otherwise the step suspends to ask
 * for it, and resumes with the operator's answer. Either way it seeds the interview
 * loop state — an empty transcript, zeroed coverage, and the default caps.
 */
export const collectLevelStep = createStep({
  id: 'collectLevel',
  inputSchema: researchOutputSchema,
  outputSchema: interviewStateSchema,
  suspendSchema: levelSuspendSchema,
  resumeSchema: levelResumeSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    const provided = inputData.targetLevel?.trim();
    const resumed = resumeData?.level?.trim();
    const level = provided && provided.length > 0 ? provided : resumed;

    if (!level) {
      return await suspend({
        kind: 'level',
        prompt: 'What seniority level should this interview target? (e.g. junior, senior, staff)',
      });
    }

    return {
      ...inputData,
      targetLevel: level,
      transcript: [],
      coverage: INITIAL_COVERAGE,
      limits: inputData.limits ?? DEFAULT_CAP_LIMITS,
      done: false,
    };
  },
});

/**
 * `interviewTurn`: one turn of the adaptive loop. On the fresh pass it checks the caps
 * and, if a question is still allowed, suspends with a (placeholder) question. On the
 * resume pass it reads that question back from the suspend data — never regenerating —
 * appends `{question, answer}` to the transcript, advances the coverage counters, and
 * marks the loop done once the caps are spent. Driven by `.dountil` below.
 */
export const interviewTurnStep = createStep({
  id: 'interviewTurn',
  inputSchema: interviewStateSchema,
  outputSchema: interviewStateSchema,
  suspendSchema: questionSuspendSchema,
  resumeSchema: answerResumeSchema,
  execute: async ({ inputData, resumeData, suspend, suspendData }) => {
    if (!resumeData) {
      // Fresh pass. If the caps are already spent (e.g. on re-entry), end without
      // asking; otherwise suspend with this turn's question and wait for the answer.
      if (interviewComplete(inputData)) {
        return { ...inputData, done: true };
      }
      const questionNumber = inputData.coverage.questionCount + 1;
      return await suspend({
        kind: 'question',
        question: placeholderQuestion(questionNumber),
        questionNumber,
      });
    }

    // Resume pass. Read the question back from the suspend data — never regenerate
    // it — so the transcript records exactly what was asked. Once questions are
    // adaptive (task 0006) a regenerated question would differ from the one the
    // candidate actually answered, so a missing payload is a hard error, not a fallback.
    if (!suspendData?.question) {
      throw new Error('Interview turn resumed without its suspended question; cannot record the transcript.');
    }
    const next = recordTurn(inputData, { question: suspendData.question, answer: resumeData.answer });

    return { ...inputData, transcript: next.transcript, coverage: next.coverage, done: interviewComplete(next) };
  },
});

/** The `.dountil` condition: stop looping once a turn reports the caps are spent. */
export function interviewLoopDone({ inputData }: { inputData: InterviewState }): boolean {
  return inputData.done === true;
}

/**
 * The interview workflow. It ingests the CV and role, performs best-effort company
 * research, collects the target level, then runs the adaptive interview loop — each
 * turn suspending with a question and resuming with the answer — until the caps bound
 * the session. It runs on a single durable run so the snapshot carries the whole
 * session, which is what lets the `resume` command reconnect by `runId`. Later tasks
 * add grading, coaching, and the report on the same run.
 */
export const interviewWorkflow = createWorkflow({
  id: 'interviewWorkflow',
  inputSchema: ingestInputSchema,
  outputSchema: interviewStateSchema,
})
  .then(ingestStep)
  .then(researchStep)
  .then(collectLevelStep)
  .dountil(interviewTurnStep, async (context) => interviewLoopDone(context))
  .commit();
