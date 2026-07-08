import { z } from 'zod';

/**
 * The four deterministic caps that bound an interview session. They keep a run
 * finite regardless of what the (later, adaptive) director decides to ask, so the
 * loop always terminates and grading has a bounded transcript to work from.
 */
export const capLimitsSchema = z.object({
  maxQuestions: z
    .number()
    .int()
    .positive()
    .describe('Hard ceiling on the total number of questions asked in a session.'),
  maxConsecutiveFollowUps: z
    .number()
    .int()
    .nonnegative()
    .describe('Most follow-ups allowed in a row before the interview must move to a new topic.'),
  maxReprompts: z
    .number()
    .int()
    .nonnegative()
    .describe('Most times one question may be re-asked after a non-answer before moving on.'),
  tokenBudget: z
    .number()
    .int()
    .positive()
    .describe('Approximate cumulative token budget (question + answer) for the whole session.'),
});

export type CapLimits = z.infer<typeof capLimitsSchema>;

/** The running counters the interview loop advances after each answered turn. */
export const coverageStateSchema = z.object({
  questionCount: z.number().int().nonnegative().default(0).describe('Questions asked so far.'),
  consecutiveFollowUps: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Follow-ups asked in a row on the current topic.'),
  repromptCount: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Times the current question has been re-asked after a non-answer.'),
  tokensUsed: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Approximate tokens consumed by questions and answers so far.'),
});

export type CoverageState = z.infer<typeof coverageStateSchema>;

/** A reasonable default budget for a single short behavioral session. */
export const DEFAULT_CAP_LIMITS: CapLimits = capLimitsSchema.parse({
  maxQuestions: 6,
  maxConsecutiveFollowUps: 2,
  maxReprompts: 1,
  tokenBudget: 40_000,
});

/** The zeroed coverage state a fresh interview starts from. */
export const INITIAL_COVERAGE: CoverageState = coverageStateSchema.parse({});

/**
 * Build a limits override that raises only the question cap, for callers (the CLI's
 * `--max-questions`) that expose a single knob. No override means "use the defaults".
 */
export function limitsWithMaxQuestions(maxQuestions: number | undefined): CapLimits | undefined {
  if (maxQuestions === undefined) return undefined;
  return capLimitsSchema.parse({ ...DEFAULT_CAP_LIMITS, maxQuestions });
}

/**
 * A cheap, dependency-free token estimate (~4 characters per token). Good enough to
 * enforce the coarse token-budget cap without pulling in a tokenizer; the exact model
 * accounting lives in observability, not here.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The kind of question the loop is about to ask; each kind answers to a different cap. */
export type QuestionKind = 'new' | 'follow-up' | 'reprompt';

/** Which cap blocked the next question, when one did. */
export type CapReason = 'question-cap' | 'follow-up-cap' | 'reprompt-cap' | 'token-budget';

export function questionCapReached(state: CoverageState, limits: CapLimits): boolean {
  return state.questionCount >= limits.maxQuestions;
}

export function followUpCapReached(state: CoverageState, limits: CapLimits): boolean {
  return state.consecutiveFollowUps >= limits.maxConsecutiveFollowUps;
}

export function repromptCapReached(state: CoverageState, limits: CapLimits): boolean {
  return state.repromptCount >= limits.maxReprompts;
}

export function tokenBudgetExhausted(state: CoverageState, limits: CapLimits): boolean {
  return state.tokensUsed >= limits.tokenBudget;
}

export interface CapDecision {
  allowed: boolean;
  reason: CapReason | null;
}

/**
 * Decide whether the interview may ask one more question of the given kind. The
 * session-terminating caps — total questions and token budget — gate every kind;
 * the follow-up cap gates only a follow-up, and the reprompt cap only a reprompt.
 * Returns the first cap that blocks, so the caller can report why the loop ended.
 */
export function allowQuestion(
  state: CoverageState,
  limits: CapLimits,
  kind: QuestionKind = 'new',
): CapDecision {
  if (questionCapReached(state, limits)) return { allowed: false, reason: 'question-cap' };
  if (tokenBudgetExhausted(state, limits)) return { allowed: false, reason: 'token-budget' };
  if (kind === 'follow-up' && followUpCapReached(state, limits)) {
    return { allowed: false, reason: 'follow-up-cap' };
  }
  if (kind === 'reprompt' && repromptCapReached(state, limits)) {
    return { allowed: false, reason: 'reprompt-cap' };
  }
  return { allowed: true, reason: null };
}
