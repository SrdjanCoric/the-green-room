import { z } from 'zod';

/**
 * The wire contract shared by the workflow core and the web client: the Zod schemas
 * for everything that crosses the client/server boundary — role context, the coach
 * report, transcript turns, the suspend payloads, and the finished-run result the
 * report screen reads. This module is the single source of truth; it depends on
 * nothing but Zod, so both the Node workflow and the browser bundle import it directly
 * and a renamed field breaks the build on both sides instead of silently drifting.
 */

// ── Role context ────────────────────────────────────────────────────────────

/**
 * A single competency the role evaluates, carrying a weight so the interview can
 * spend its limited turns on what this posting cares about most.
 */
export const competencySchema = z.object({
  name: z
    .string()
    .describe('A competency the role evaluates, e.g. "system design" or "stakeholder management".'),
  weight: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe(
      'How heavily the posting emphasizes this competency, an integer from 1 (barely) to 5 (core); higher competencies are probed more in the interview.',
    ),
});

/**
 * The role the candidate is interviewing for, distilled from a job posting: who is
 * hiring, for what, the competencies to assess (weighted), and any published values
 * framework the posting maps onto. Downstream the director uses the weights to steer
 * the interview and the grader uses them to score.
 */
export const roleContextSchema = z.object({
  company: z.string().optional().describe('Hiring company name, if the posting identifies it.'),
  role: z.string().describe('The job title the candidate is interviewing for.'),
  seniority: z
    .string()
    .optional()
    .describe('Seniority level as stated, e.g. "junior", "senior", "staff".'),
  summary: z.string().optional().describe('One or two sentences describing the role and its scope.'),
  competencies: z
    .array(competencySchema)
    .default([])
    .describe('Weighted competencies the interview should assess, most important first.'),
  framework: z
    .string()
    .optional()
    .describe(
      'The published values or leadership framework the round maps onto, if the company has one, e.g. "Amazon Leadership Principles". Omitted when there is none.',
    ),
});

export type Competency = z.infer<typeof competencySchema>;
export type RoleContext = z.infer<typeof roleContextSchema>;

/**
 * The role context used when the candidate provides no job posting: a generic
 * behavioral interview weighting the competencies common to most roles equally, so
 * the interview can still proceed. Parsed through the schema so it is guaranteed
 * valid and array defaults are applied.
 */
export const DEFAULT_ROLE_CONTEXT: RoleContext = roleContextSchema.parse({
  role: 'General behavioral interview',
  summary: 'No job posting was provided; running a general behavioral interview.',
  competencies: [
    { name: 'Communication', weight: 3 },
    { name: 'Problem solving', weight: 3 },
    { name: 'Collaboration', weight: 3 },
    { name: 'Ownership', weight: 3 },
  ],
});

// ── Transcript ──────────────────────────────────────────────────────────────

/**
 * One recorded exchange of the interview: the question posed and the candidate's
 * verbatim answer. Answers are kept word-for-word — grading scores the exact text,
 * so nothing here is summarized.
 */
export const transcriptEntrySchema = z.object({
  question: z.string().describe('The question the interviewer asked this turn.'),
  answer: z.string().describe("The candidate's answer, verbatim."),
});

export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

// ── Coach report ──────────────────────────────────────────────────────────────

export const answerAdviceSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe('The interview question this advice is about, quoted near-verbatim.'),
  diagnosis: z
    .string()
    .min(1)
    .describe(
      'What specifically held this answer back, named against what the candidate actually said, not in the abstract.',
    ),
  fix: z
    .string()
    .min(1)
    .describe(
      "The concrete thing to do differently next time, tied to this answer's own gap: what to add, name, or quantify. Never generic advice like \"be more specific\".",
    ),
});

export type AnswerAdvice = z.infer<typeof answerAdviceSchema>;

export const drillSchema = z.object({
  focus: z.string().min(1).describe('The recurring weakness this drill builds, named in plain words.'),
  exercise: z
    .string()
    .min(1)
    .describe('A concrete practice exercise the candidate can run on their own to build it.'),
});

export type Drill = z.infer<typeof drillSchema>;

export const coachReportSchema = z.object({
  summary: z
    .string()
    .describe(
      'A candid read of how the session went across the answers: what is already working and what most needs work.',
    ),
  answerAdvice: z
    .array(answerAdviceSchema)
    .default([])
    .describe('One entry per answer that needs work, in transcript order. Strong answers are left out.'),
  drills: z
    .array(drillSchema)
    .default([])
    .describe('A drill per recurring weak area the session surfaced. Empty when nothing recurs.'),
  studyPlan: z
    .string()
    .describe('A short plan aggregating the weak areas into what to work on, in priority order.'),
});

export type CoachReport = z.infer<typeof coachReportSchema>;

// ── Suspend payloads (web-facing wire view) ─────────────────────────────────

/**
 * The suspend payloads narrowed to exactly what the web client consumes. The Node
 * workflow extends these with its own private fields (the director's move, the failed
 * stage) via `.extend()`, so the wire fields the browser reads are defined once here —
 * a rename breaks both sides.
 */
export const levelSuspendWireSchema = z.object({
  kind: z.literal('level'),
  prompt: z.string().describe('The question asking the operator for the target level.'),
});

export const questionSuspendWireSchema = z.object({
  kind: z.literal('question'),
  question: z.string().describe('The question posed to the candidate this turn.'),
  questionNumber: z.number().int().positive().describe('1-based index of this question.'),
});

export const failureSuspendWireSchema = z.object({
  kind: z.literal('failure'),
  reason: z.string().describe('What failed, in operator-readable terms.'),
});

/** Every payload an interview run can suspend with, as the web client sees it. */
export const interviewSuspendWireSchema = z.discriminatedUnion('kind', [
  levelSuspendWireSchema,
  questionSuspendWireSchema,
  failureSuspendWireSchema,
]);

export type SuspendPayload = z.infer<typeof interviewSuspendWireSchema>;

// ── Finished-run result ───────────────────────────────────────────────────────

/**
 * The subset of the workflow's final result the report screen consumes. Composed from
 * the shared pieces above, so the field *names* here (`roleContext`, `coaching`,
 * `transcript`) are the contract; the web maps `roleContext.role`/`.company` onto its
 * flattened report view. Lenient parse (`.passthrough`-free `z.object` ignores extras)
 * so the far larger run state parses down to just what the screen needs.
 */
export const interviewReportResultSchema = z.object({
  coaching: coachReportSchema,
  transcript: z.array(transcriptEntrySchema).default([]),
  roleContext: roleContextSchema.optional(),
  targetLevel: z.string().optional(),
  reportPath: z.string().optional(),
});

export type InterviewReportResult = z.infer<typeof interviewReportResultSchema>;

/**
 * The finished interview as the web client holds and caches it: the coaching notes and
 * transcript, plus the role/company flattened out of `roleContext` for display. Used to
 * validate a report hydrated from `localStorage`, so corrupt or stale cached data falls
 * back cleanly instead of rendering an ill-formed report.
 */
export const interviewReportViewSchema = z.object({
  coaching: coachReportSchema,
  transcript: z.array(transcriptEntrySchema).default([]),
  targetLevel: z.string().optional(),
  reportPath: z.string().optional(),
  role: z.string().optional(),
  company: z.string().optional(),
});

export type InterviewReportView = z.infer<typeof interviewReportViewSchema>;
