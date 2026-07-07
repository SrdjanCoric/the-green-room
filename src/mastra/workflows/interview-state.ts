import { z } from 'zod';

import {
  allowQuestion,
  capLimitsSchema,
  coverageStateSchema,
  type CapLimits,
  type CoverageState,
} from '../interview/interview-caps';
import { topicAssessmentSchema } from '../schemas/answer-assessment';
import { candidateProfileSchema } from '../schemas/candidate-profile';
import { companyBriefSchema } from '../schemas/company-brief';
import {
  coachReportSchema,
  sessionGradeSchema,
  sessionGradeForTranscriptSchema,
} from '../schemas/coach-report';
import { directorActionSchema } from '../schemas/director-decision';
import { transcriptEntrySchema } from '../schemas/interview';
import { roleContextSchema } from '../schemas/role-context';

export const ingestInputSchema = z.object({
  // `cvPath` is a local filesystem path read directly by the ingest step. In the
  // CLI it is the operator's own trusted input. Over the Mastra server that path
  // is attacker-controlled, so the ingest step confines it to the upload directory
  // unless a trusted process (the CLI) opts out.
  cvPath: z.string().describe('Path to the candidate CV file (.pdf, .txt, or .md).'),
  candidate: z
    .string()
    .optional()
    .describe(
      'Explicit candidate id override. When omitted, identity falls back to the first ' +
        "email address in the CV text, then to the literal 'default'.",
    ),
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
    .array(z.url())
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

export const ingestOutputSchema = z.object({
  profile: candidateProfileSchema,
  roleContext: roleContextSchema,
  candidateId: z
    .string()
    .describe('The resolved candidate identity; keys resource-scoped working memory.'),
  candidateIdOrigin: z
    .enum(['flag', 'cv', 'default'])
    .describe('Where the candidate id came from: explicit override, CV email, or fallback.'),
  threadId: z.string().describe('Id for this interview session, carried for memory writes.'),
  researchUrls: z.array(z.url()).default([]),
  targetLevel: z.string().optional(),
  limits: capLimitsSchema.optional(),
});

export const researchOutputSchema = ingestOutputSchema.extend({
  companyBrief: companyBriefSchema,
});

/**
 * The state threaded through the interview loop: the ingest/research output plus a
 * resolved target level, the running transcript, the per-answer assessment log the
 * director reads, the topic currently under discussion, the coverage counters, the caps
 * bounding the session, and a `done` flag the loop condition reads to stop.
 */
export const interviewStateSchema = researchOutputSchema.extend({
  targetLevel: z.string().describe('The resolved seniority level the interview targets.'),
  transcript: z.array(transcriptEntrySchema).default([]),
  assessments: z
    .array(topicAssessmentSchema)
    .default([])
    .describe('The assessor read of each answered turn, in order; the director reads it.'),
  currentTopic: z
    .string()
    .default('')
    .describe('The topic the conversation is on, carried across follow-ups and reprompts.'),
  coverage: coverageStateSchema,
  limits: capLimitsSchema,
  done: z.boolean().default(false).describe('True once the caps end the interview loop.'),
});

export type InterviewState = z.infer<typeof interviewStateSchema>;

export const closedInterviewStateSchema = interviewStateSchema.extend({
  closingMessage: z.string().describe('The interviewer sign-off after the final turn.'),
});

export type ClosedInterviewState = z.infer<typeof closedInterviewStateSchema>;

export const gradedInterviewStateSchema = closedInterviewStateSchema.extend({
  grade: sessionGradeSchema.describe('Answer-by-answer grade for the finished transcript.'),
});

export type GradedInterviewState = z.infer<typeof gradedInterviewStateSchema>;

export const coachedInterviewStateSchema = gradedInterviewStateSchema.extend({
  coaching: coachReportSchema.describe('Candidate-facing coaching advice for the session.'),
});

export type CoachedInterviewState = z.infer<typeof coachedInterviewStateSchema>;

export const reportedInterviewStateSchema = coachedInterviewStateSchema.extend({
  reportPath: z.string().describe('Path to the Markdown coaching report written for this run.'),
  reportGeneratedAt: z.string().describe('ISO timestamp used for the report filename.'),
}).superRefine((state, context) => {
  const parsed = sessionGradeForTranscriptSchema(state.transcript.length).safeParse(state.grade);
  if (!parsed.success) {
    context.addIssue({
      code: 'custom',
      path: ['grade'],
      message: 'grade must cover every transcript turn exactly once',
    });
  }
});

export type ReportedInterviewState = z.infer<typeof reportedInterviewStateSchema>;

/** Suspend payload for the target-level prompt: what to ask, tagged for the client. */
export const levelSuspendSchema = z.object({
  kind: z.literal('level'),
  prompt: z.string().describe('The question asking the operator for the target level.'),
});

/** Resume payload answering the target-level prompt. */
export const levelResumeSchema = z.object({
  level: z.string().describe('The chosen seniority level.'),
});

/**
 * Suspend payload for an interview turn: the question posed to the candidate, plus the
 * director's move that produced it. The `action` and `subject` ride across the suspend so
 * the resume pass can advance the per-topic coverage counters and the current topic for
 * the exact move that was asked — never re-deciding, which would drift. The director's
 * private reasoning is deliberately not carried; the client only needs the question.
 */
export const questionSuspendSchema = z.object({
  kind: z.literal('question'),
  question: z.string().describe('The question posed to the candidate this turn.'),
  questionNumber: z.number().int().positive().describe('1-based index of this question.'),
  action: directorActionSchema.describe('The director move that produced this question.'),
  subject: z
    .string()
    .default('')
    .describe('For a new_topic move, the topic opened; empty otherwise.'),
});

/** Resume payload for an interview turn: the candidate's answer. */
export const answerResumeSchema = z.object({
  answer: z.string().describe("The candidate's answer to the suspended question."),
});

/**
 * Suspend payload for a turn whose agent work failed past its bounded retries. The run
 * stays suspended — the transcript safe in the snapshot — instead of failing, and the
 * `resume` command retries the turn. When the failure hit the resume pass (the answer
 * had already arrived), `pending` carries the complete answered turn so the retry
 * replays it — assess only — and the candidate is never re-asked.
 */
export const failureSuspendSchema = z.object({
  kind: z.literal('failure'),
  reason: z.string().describe('What failed, in operator-readable terms.'),
  stage: z
    .enum(['director', 'interviewer', 'assessor'])
    .describe('The turn stage whose agent call failed.'),
  pending: z
    .object({
      question: z.string(),
      questionNumber: z.number().int().positive(),
      action: directorActionSchema,
      subject: z.string().default(''),
      answer: z.string(),
    })
    .optional()
    .describe('The answered turn awaiting assessment when the failure hit a resume pass.'),
});

/** Resume payload retrying a turn that suspended with a failure payload. */
export const retryResumeSchema = z.object({
  retry: z.literal(true).describe('Retry the failed turn.'),
});

/** Everything the interview-turn step can suspend with: a question, or a failure. */
export const turnSuspendSchema = z.discriminatedUnion('kind', [
  questionSuspendSchema,
  failureSuspendSchema,
]);

/** Everything the interview-turn step can resume with: an answer, or a retry. */
export const turnResumeSchema = z.union([answerResumeSchema, retryResumeSchema]);

/** Every payload an interview run can suspend with, discriminated by `kind`. */
export const interviewSuspendSchema = z.discriminatedUnion('kind', [
  levelSuspendSchema,
  questionSuspendSchema,
  failureSuspendSchema,
]);

/** The things an interview run can suspend to ask for: a level, or an answer. */
export type InterviewSuspend = z.infer<typeof interviewSuspendSchema>;

/** Narrow an arbitrary suspend payload to the interview union, or `undefined`. */
export function asInterviewSuspend(payload: unknown): InterviewSuspend | undefined {
  const parsed = interviewSuspendSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Pull the pending suspend payload out of a suspended run result. `result.suspendPayload`
 * is a map keyed by the suspended step id; this linear workflow suspends one step at a
 * time, so there is normally a single entry. Rather than assume that, return the first
 * value that narrows to the interview union — so an unrelated concurrent suspension (were
 * one ever added) can't shadow the interview prompt. (The workflow state reader, used on
 * reconnect, exposes the payload directly instead — pass that through `asInterviewSuspend`.)
 */
export function readSuspendPayload(suspendPayload: unknown): InterviewSuspend | undefined {
  if (suspendPayload === null || typeof suspendPayload !== 'object') return undefined;
  for (const value of Object.values(suspendPayload)) {
    const payload = asInterviewSuspend(value);
    if (payload) return payload;
  }
  return undefined;
}

/** The slice of interview state the caps read to decide whether the loop may continue. */
export interface InterviewTurnState {
  coverage: CoverageState;
  limits: CapLimits;
}

/** True once no further question is allowed under the session-ending caps — the loop ends. */
export function interviewComplete(state: InterviewTurnState): boolean {
  return !allowQuestion(state.coverage, state.limits, 'new').allowed;
}
