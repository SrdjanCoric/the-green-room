import type { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';

import {
  answerAssessmentSchema,
  type AnswerAssessment,
  type TopicAssessment,
} from '../schemas/answer-assessment';
import type { CandidateProfile } from '../schemas/candidate-profile';
import type { CompanyBrief } from '../schemas/company-brief';
import {
  directorDecisionSchema,
  type DirectorAction,
  type DirectorDecision,
} from '../schemas/director-decision';
import {
  streamingTextCall,
  structuredCall,
  type ChunkSink,
  type StructuredGenerator,
  type TextStreamer,
} from '../structured-call';
import type { TranscriptEntry } from '../schemas/interview';
import type { RoleContext } from '../schemas/role-context';
import { CLOSING_SYSTEM_PROMPT } from '../agents/interviewer';
import { neutralizeFences } from '../prompt-safety';
import {
  estimateTokens,
  followUpCapReached,
  repromptCapReached,
  type CapLimits,
  type CoverageState,
} from './interview-caps';

/**
 * The read-only slice of interview state the director and interviewer reason over: who
 * the candidate is, the role and company, the conversation so far, the assessment log,
 * and the running cap counters. `InterviewState` satisfies this structurally.
 */
export interface BrainState {
  profile: CandidateProfile;
  roleContext: RoleContext;
  companyBrief: CompanyBrief;
  transcript: TranscriptEntry[];
  assessments: TopicAssessment[];
  coverage: CoverageState;
  limits: CapLimits;
}

/**
 * Whether the director has already been told an avenue is spent this turn. The cap-nudge
 * loop sets these before re-consulting the director, so its prompt can say the follow-up
 * or reprompt cap is exhausted and it should pick a different move.
 */
export interface DirectorNudge {
  followUpsExhausted: boolean;
  repromptsExhausted: boolean;
}

const NO_NUDGE: DirectorNudge = { followUpsExhausted: false, repromptsExhausted: false };

// --- Rendering: turn structured state into the plain-text blocks the prompts carry. ---

/** Render a candidate profile into a plain-text block for the prompts. */
export function renderProfile(profile: CandidateProfile): string {
  const sections: string[] = [];
  if (profile.headline) sections.push(`Headline: ${profile.headline}`);
  if (profile.roles.length > 0) {
    const roles = profile.roles.map((role) => {
      const where = role.company ? `, ${role.company}` : '';
      const when = role.startDate || role.endDate ? ` (${role.startDate ?? '?'}–${role.endDate ?? '?'})` : '';
      const summary = role.summary ? `: ${role.summary}` : '';
      return `- ${role.title}${where}${when}${summary}`;
    });
    sections.push('Roles:\n' + roles.join('\n'));
  }
  if (profile.projects.length > 0) {
    const projects = profile.projects.map(
      (project) => `- ${project.name}${project.description ? `: ${project.description}` : ''}`,
    );
    sections.push('Projects:\n' + projects.join('\n'));
  }
  if (profile.quantifiedClaims.length > 0) {
    sections.push('Claims with numbers:\n' + profile.quantifiedClaims.map((c) => `- ${c}`).join('\n'));
  }
  if (profile.technologies.length > 0) {
    sections.push('Technologies: ' + profile.technologies.join(', '));
  }
  return sections.join('\n') || 'The profile is empty.';
}

/** Render interview turns into a Q/A plain-text transcript. */
export function renderTranscript(transcript: TranscriptEntry[]): string {
  return transcript.map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`).join('\n');
}

/** Render the role context plus weighted competencies for the director prompt. */
export function renderRoleDetails(context: RoleContext): string {
  const lines: string[] = [];
  if (context.company) lines.push(`Company: ${context.company}`);
  lines.push(`Role: ${context.role}`);
  if (context.framework) {
    lines.push(`Values framework: ${context.framework}`);
  }
  if (context.competencies.length > 0) {
    const weighted = [...context.competencies]
      .sort((a, b) => b.weight - a.weight)
      .map((competency) => `${competency.name} (${competency.weight})`)
      .join(', ');
    lines.push(`Competencies the posting emphasizes, most first: ${weighted}`);
  }
  return lines.join('\n');
}

/** Render the role context (no competencies) for the interviewer's grounding. */
export function renderRoleContext(context: RoleContext): string {
  const lines: string[] = [];
  if (context.company) lines.push(`Company: ${context.company}`);
  lines.push(`Role: ${context.role}`);
  if (context.framework) {
    lines.push(`Values framework: ${context.framework}`);
  }
  return lines.join('\n');
}

/** Render a company brief into plain text, or the empty string when there is nothing to say. */
export function renderBrief(brief: CompanyBrief): string {
  const parts: string[] = [];
  if (brief.summary.trim()) parts.push(brief.summary.trim());
  if (brief.facts.length > 0) parts.push(brief.facts.map((fact) => `- ${fact}`).join('\n'));
  return parts.join('\n');
}

/** The STAR elements an assessed answer has not stated yet, for the director's notes. */
function starGaps(entry: TopicAssessment): string[] {
  const star = entry.assessment.star;
  const missing: string[] = [];
  if (!star.situation) missing.push('situation');
  if (!star.task) missing.push('task');
  if (!star.action) missing.push('action');
  if (!star.result) missing.push('result');
  if (star.result && !star.quantifiedResult) missing.push('a number on the result');
  return missing;
}

/** Render the per-topic assessment log into a plain-text block for the director prompt. */
export function renderAssessments(log: TopicAssessment[]): string {
  if (log.length === 0) return 'No answers assessed yet.';
  return log
    .map((entry, index) => {
      const signal = entry.assessment.sufficientSignal
        ? 'the topic holds enough signal'
        : 'the topic needs more signal';
      let line = `After answer ${index + 1} (topic: ${entry.topic}): ${signal}`;
      const gaps = starGaps(entry);
      if (gaps.length > 0) line += `; story elements not stated yet: ${gaps.join(', ')}`;
      if (entry.assessment.claimsWorthChasing.length > 0) {
        line += `; worth chasing: ${entry.assessment.claimsWorthChasing.join(', ')}`;
      }
      return line;
    })
    .join('\n');
}

const FOLLOW_UP_DIRECTIVE = (decision: DirectorDecision): string =>
  `Follow up on this from their last answer: ${neutralizeFences(decision.subject)}. Why it matters: ${neutralizeFences(decision.reason)}. ` +
  'Ask one question that draws that story out, anchored in what they have already said.';

const NEW_TOPIC_DIRECTIVE = (decision: DirectorDecision): string =>
  `The interview now turns to: ${neutralizeFences(decision.subject)}. Why now: ${neutralizeFences(decision.reason)}. ` +
  'Ask one question that opens it.';

const REPROMPT_DIRECTIVE = (decision: DirectorDecision): string =>
  `They have not actually answered this yet: ${neutralizeFences(decision.subject)}. Why it matters: ${neutralizeFences(decision.reason)}. ` +
  'Warmly put the question to them once more, asking directly for the substance you still need. ' +
  'Stay friendly and assume good faith - do not point out that they sidestepped it or say they ' +
  'failed to answer; just invite the story, anchored in what they have said.';

/** Render a director decision into the directive line the interviewer follows. */
export function renderDirective(decision: DirectorDecision): string {
  switch (decision.action) {
    case 'follow_up':
      return FOLLOW_UP_DIRECTIVE(decision);
    case 'new_topic':
      return NEW_TOPIC_DIRECTIVE(decision);
    case 'reprompt':
      return REPROMPT_DIRECTIVE(decision);
    default:
      throw new Error(
        `renderDirective received the closing action "${decision.action}"; ` +
          'wrap_up and terminate end the loop rather than asking a question.',
      );
  }
}

// --- Prompt builders: the user message each agent gets (its system prompt is fixed). ---

const FOLLOW_UPS_EXHAUSTED_LINE =
  'Follow-ups on the current topic are exhausted: open a new topic or wrap up.\n';
const REPROMPTS_EXHAUSTED_LINE =
  'You have already re-prompted this question once: open a new topic or wrap up.\n';

/** Build the user message that asks the director to decide the next move. */
export function buildDirectorPrompt(state: BrainState, nudge: DirectorNudge = NO_NUDGE): string {
  const brief = neutralizeFences(renderBrief(state.companyBrief));
  const briefBlock = brief
    ? `Here is the company brief between the <brief> tags.\n<brief>\n${brief}\n</brief>\n`
    : 'No company brief is available.\n';
  const transcript = neutralizeFences(renderTranscript(state.transcript));
  const transcriptBlock = transcript
    ? `Here is the interview so far between the <transcript> tags.\n<transcript>\n${transcript}\n</transcript>\n`
    : 'The interview has not started yet.\n';

  return (
    `Here are the role details.\n${renderRoleDetails(state.roleContext)}\n` +
    briefBlock +
    `Here is the candidate profile between the <profile> tags.\n<profile>\n${neutralizeFences(
      renderProfile(state.profile),
    )}\n</profile>\n` +
    transcriptBlock +
    `Assessment notes so far: ${renderAssessments(state.assessments)}\n` +
    `Questions asked so far: ${state.coverage.questionCount}. You have a budget of ${state.limits.maxQuestions} questions for the whole session - a ceiling, never a target: wrap up as soon as the signal is sufficient.\n` +
    `Consecutive follow-ups on the current topic: ${state.coverage.consecutiveFollowUps} of a hard cap of ${state.limits.maxConsecutiveFollowUps}.\n` +
    `Reprompts on the current question: ${state.coverage.repromptCount} of a hard cap of ${state.limits.maxReprompts}.\n` +
    (nudge.followUpsExhausted ? FOLLOW_UPS_EXHAUSTED_LINE : '') +
    (nudge.repromptsExhausted ? REPROMPTS_EXHAUSTED_LINE : '') +
    'Decide what happens next.'
  );
}

/** Build the user message that asks the interviewer to phrase the next question. */
export function buildInterviewerPrompt(state: BrainState, decision: DirectorDecision): string {
  const roleDetails = renderRoleContext(state.roleContext);
  const roleBlock = roleDetails ? `Here are the role details.\n${roleDetails}\n` : '';
  const brief = neutralizeFences(renderBrief(state.companyBrief));
  const briefBlock = brief
    ? `Here is the company brief between the <brief> tags.\n<brief>\n${brief}\n</brief>\n`
    : '';
  const transcript = neutralizeFences(renderTranscript(state.transcript));
  const transcriptBlock = transcript
    ? `Here is the interview so far between the <transcript> tags.\n<transcript>\n${transcript}\n</transcript>\n`
    : '';

  return (
    roleBlock +
    briefBlock +
    `Here is the candidate profile between the <profile> tags.\n<profile>\n${neutralizeFences(
      renderProfile(state.profile),
    )}\n</profile>\n` +
    transcriptBlock +
    renderDirective(decision)
  );
}

/** Build the user message that asks the assessor to read the latest answer. */
export function buildAssessorPrompt(topic: string, transcript: TranscriptEntry[]): string {
  return (
    `The current topic of conversation: ${topic || 'the opening of the interview'}\n` +
    'Here is the interview so far between the <transcript> tags; assess the latest answer.\n' +
    `<transcript>\n${neutralizeFences(renderTranscript(transcript))}\n</transcript>`
  );
}

// --- Agent boundaries: every call goes through the shared structured/text helpers. ---

/** Decide the next move via the director agent, nudge flags folded into the prompt. */
export type DirectorDecider = (state: BrainState, nudge: DirectorNudge) => Promise<DirectorDecision>;

/** Render one director decision into the question text via the interviewer agent. */
export type InterviewerWriter = (state: BrainState, decision: DirectorDecision) => Promise<string>;

/** Assess the latest answer on the current topic via the assessor agent. */
export type AnswerAssessor = (topic: string, transcript: TranscriptEntry[]) => Promise<AnswerAssessment>;

/** Real director decider: run the director agent with structured output on the smart tier. */
export function createDirectorDecider(
  agent: StructuredGenerator,
  requestContext: RequestContext,
): DirectorDecider {
  return async (state, nudge) =>
    structuredCall(agent, buildDirectorPrompt(state, nudge), directorDecisionSchema, requestContext, {
      description: 'director',
    });
}

/**
 * Real interviewer writer: stream the interviewer agent on the fast tier and trim its
 * text. Token chunks are forwarded to `sink` (the workflow step's `writer`) so the
 * question types out live in a client watching the run stream.
 */
export function createInterviewerWriter(
  agent: TextStreamer,
  requestContext: RequestContext,
  sink?: ChunkSink,
): InterviewerWriter {
  return async (state, decision) =>
    streamingTextCall(agent, buildInterviewerPrompt(state, decision), requestContext, {
      description: 'interviewer',
      sink,
    });
}

/** Build the user message that asks the interviewer to close the finished session. */
export function buildClosingPrompt(state: Pick<BrainState, 'transcript'>): string {
  return (
    'The interview is over.\n' +
    'Here is the full interview between the <transcript> tags.\n' +
    `<transcript>\n${neutralizeFences(renderTranscript(state.transcript))}\n</transcript>\n` +
    'Say goodbye to the candidate.'
  );
}

/** Speak the finished session's closing line via the interviewer agent. */
export type ClosingWriter = (state: Pick<BrainState, 'transcript'>) => Promise<string>;

/**
 * Real closing writer: the interviewer agent streams the goodbye under the closing
 * instructions override, so the wrap-up is written fresh for this session instead of
 * phrased as another question. Token chunks are forwarded to `sink` like a question's.
 */
export function createClosingWriter(
  agent: TextStreamer,
  requestContext: RequestContext,
  sink?: ChunkSink,
): ClosingWriter {
  return async (state) =>
    streamingTextCall(agent, buildClosingPrompt(state), requestContext, {
      description: 'closing',
      sink,
      instructions: CLOSING_SYSTEM_PROMPT,
    });
}

/** Resolves the closing writer from the run's Mastra registry, mirroring the brain factory. */
export type ClosingFactory = (
  registry: BrainRegistry,
  requestContext: RequestContext,
  sink?: ChunkSink,
) => ClosingWriter;

/** Production closing: the interviewer agent on the fast tier, closing instructions swapped in. */
export const agentClosingFactory: ClosingFactory = (registry, requestContext, sink) =>
  createClosingWriter(registry.getAgent('interviewer'), requestContext, sink);

/** Real assessor: run the assessor agent with structured output on the fast tier. */
export function createAnswerAssessor(
  agent: StructuredGenerator,
  requestContext: RequestContext,
): AnswerAssessor {
  return async (topic, transcript) =>
    structuredCall(agent, buildAssessorPrompt(topic, transcript), answerAssessmentSchema, requestContext, {
      description: 'assessor',
    });
}

/** The three agent-backed callables the interview turn drives, resolved per run. */
export interface AdaptiveBrain {
  decide: DirectorDecider;
  question: InterviewerWriter;
  assess: AnswerAssessor;
}

/** Resolves the three interview agents from the run's Mastra registry and request context. */
export interface BrainRegistry {
  getAgent(id: string): Agent;
}

export type BrainFactory = (
  registry: BrainRegistry,
  requestContext: RequestContext,
  sink?: ChunkSink,
) => AdaptiveBrain;

/** Production brain: director on smart, interviewer and assessor on fast. */
export const agentBrainFactory: BrainFactory = (registry, requestContext, sink) => ({
  decide: createDirectorDecider(registry.getAgent('director'), requestContext),
  question: createInterviewerWriter(registry.getAgent('interviewer'), requestContext, sink),
  assess: createAnswerAssessor(registry.getAgent('assessor'), requestContext),
});

// --- Cap-nudge logic and coverage advancement. ---

const FOLLOW_UPS_EXHAUSTED_WRAP_REASON =
  'Follow-ups on the current topic are exhausted and the director offered no new topic; wrapping up.';
const REPROMPTS_EXHAUSTED_WRAP_REASON =
  'This question has already been re-prompted and the director offered no new topic; wrapping up.';

function wrapUp(reason: string): DirectorDecision {
  return { action: 'wrap_up', subject: '', reason };
}

/**
 * Ask the director for the next move, nudging past a capped avenue. An over-cap
 * `follow_up` or `reprompt` earns exactly one re-decide, told that avenue is spent; each
 * capped action gets its own single nudge, so this settles in at most two re-decides
 * before falling back to `wrap_up`. The caller has already confirmed a question is
 * allowed under the session-ending caps, so only the per-topic caps are checked here.
 */
export async function decideNextMove(params: {
  coverage: CoverageState;
  limits: CapLimits;
  decide: (nudge: DirectorNudge) => Promise<DirectorDecision>;
}): Promise<DirectorDecision> {
  const { coverage, limits, decide } = params;
  let decision = await decide(NO_NUDGE);
  let followUpsNudged = false;
  let repromptsNudged = false;

  for (;;) {
    if (decision.action === 'follow_up' && followUpCapReached(coverage, limits)) {
      if (followUpsNudged) return wrapUp(FOLLOW_UPS_EXHAUSTED_WRAP_REASON);
      followUpsNudged = true;
    } else if (decision.action === 'reprompt' && repromptCapReached(coverage, limits)) {
      if (repromptsNudged) return wrapUp(REPROMPTS_EXHAUSTED_WRAP_REASON);
      repromptsNudged = true;
    } else {
      return decision;
    }
    decision = await decide({ followUpsExhausted: followUpsNudged, repromptsExhausted: repromptsNudged });
  }
}

/** The decision fields that drive coverage advancement — action and (for a new topic) subject. */
export interface CoverageMove {
  action: DirectorAction;
  subject: string;
}

/**
 * Advance the coverage counters and current topic for one answered turn, according to the
 * move that produced it. A `follow_up` deepens the current topic (its counter climbs, the
 * reprompt counter resets); a `reprompt` re-asks the same question (the follow-up counter
 * carries over, the reprompt counter climbs); a `new_topic` opens fresh ground (both
 * per-topic counters reset and the topic becomes the decision's subject). Every kind
 * spends one question and its question+answer tokens. Pure — returns new values, mutates
 * nothing. Only question-producing moves reach here; closing moves end the loop instead.
 */
export function advanceCoverage(
  state: { coverage: CoverageState; currentTopic: string },
  move: CoverageMove,
  entry: TranscriptEntry,
): { coverage: CoverageState; currentTopic: string } {
  const prior = state.coverage;
  const questionCount = prior.questionCount + 1;
  const tokensUsed =
    prior.tokensUsed + estimateTokens(entry.question) + estimateTokens(entry.answer);

  if (move.action === 'follow_up') {
    return {
      coverage: {
        questionCount,
        consecutiveFollowUps: prior.consecutiveFollowUps + 1,
        repromptCount: 0,
        tokensUsed,
      },
      currentTopic: state.currentTopic,
    };
  }
  if (move.action === 'reprompt') {
    return {
      coverage: {
        questionCount,
        consecutiveFollowUps: prior.consecutiveFollowUps,
        repromptCount: prior.repromptCount + 1,
        tokensUsed,
      },
      currentTopic: state.currentTopic,
    };
  }
  if (move.action === 'new_topic') {
    // Fresh ground: both per-topic counters reset, and the topic becomes the subject.
    return {
      coverage: { questionCount, consecutiveFollowUps: 0, repromptCount: 0, tokensUsed },
      currentTopic: move.subject,
    };
  }
  // wrap_up and terminate end the loop before a turn is recorded, so they must never
  // reach here. Guard explicitly rather than silently miscounting a closing move as a
  // new topic, mirroring renderDirective's guard against the same closing actions.
  throw new Error(
    `advanceCoverage received the closing action "${move.action}"; ` +
      'wrap_up and terminate end the loop rather than recording a turn.',
  );
}
