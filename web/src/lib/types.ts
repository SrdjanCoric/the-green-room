// Domain types the React app speaks. They mirror the server-side workflow schemas
// (candidate profile, coach report, suspend payloads) but are hand-declared here so
// the browser bundle never imports the Node-only workflow code. The single source of
// truth remains the Zod schemas under `src/mastra/schemas`; these must stay in step.

/** One answered turn of the interview. */
export interface TranscriptEntry {
  question: string;
  answer: string;
}

/** One piece of per-answer coaching, in transcript order. */
export interface AnswerAdvice {
  question: string;
  diagnosis: string;
  fix: string;
}

/** A practice drill for a recurring weak area. */
export interface Drill {
  focus: string;
  exercise: string;
}

/** The coach's structured notes — the "director's notes" report screen. */
export interface CoachReport {
  summary: string;
  answerAdvice: AnswerAdvice[];
  drills: Drill[];
  studyPlan: string;
}

/** The finished interview the report screen renders. */
export interface InterviewReport {
  coaching: CoachReport;
  transcript: TranscriptEntry[];
  targetLevel?: string;
  reportPath?: string;
  /** The role interviewed for, when the run resolved one. */
  role?: string;
  /** The company the role is at, when known. */
  company?: string;
}

/** How the setup form presented the posting: a link to fetch, or literal pasted text. */
export type PostingInputKind = 'link' | 'paste';

/**
 * What the workflow suspended for: a behavioural question, the target level, or a
 * failed turn held open for a retry (the run is alive; resuming with `{ retry: true }`
 * re-runs the turn).
 */
export type SuspendPayload =
  | { kind: 'question'; question: string; questionNumber: number }
  | { kind: 'level'; prompt: string }
  | { kind: 'failure'; reason: string };

/**
 * A domain event yielded by an {@link InterviewClient} as a run streams. The React
 * layer consumes these; it never sees a raw Mastra stream chunk.
 */
export type InterviewEvent =
  | { type: 'cue'; label: string }
  /** A fresh reply begins — accumulated deltas belong to a failed attempt; drop them. */
  | { type: 'question-start' }
  | { type: 'question-delta'; text: string }
  | { type: 'closing-start' }
  | { type: 'closing-delta'; text: string }
  | { type: 'report-start' }
  | { type: 'report-delta'; text: string }
  | { type: 'suspended'; suspend: SuspendPayload }
  | { type: 'completed'; report: InterviewReport }
  | { type: 'failed'; message: string };

/** The optional advanced "ensemble" overrides from the setup form. */
export interface EnsembleSelection {
  provider: string;
  fastModel: string;
  smartModel: string;
}

/** Everything the setup form gathers to start a run. */
export interface StartInterviewInput {
  /** Server path to the uploaded CV, returned by `/prepare-interview`. */
  cvPath: string;
  /** Resolved posting text, if any. */
  postingText?: string;
  /** URLs the research step may fetch for company context. */
  researchUrls: string[];
  /** Seniority level; when omitted the run suspends to ask for it. */
  targetLevel?: string;
  /** Stable candidate id (resource-scoped memory key). */
  candidate: string;
  /** This interview session's id. */
  threadId: string;
  /** Optional model-tier overrides; omitted means server defaults. */
  ensemble?: EnsembleSelection;
}

/**
 * The transport the interview screens drive. Both methods return an async iterable of
 * {@link InterviewEvent}. A test supplies a scripted implementation; production uses
 * the `@mastra/client-js`-backed one.
 */
export interface InterviewClient {
  /** Start a run and stream toward the first suspend (a question or the level prompt). */
  start(input: StartInterviewInput): { runId: string; events: AsyncIterable<InterviewEvent> };
  /** Resume a suspended run — with an answer, a level, or a failed-turn retry — and keep streaming. */
  resume(
    runId: string,
    resumeData: { answer: string } | { level: string } | { retry: true },
  ): AsyncIterable<InterviewEvent>;
}
