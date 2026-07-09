// Domain types the React app speaks. The types that cross the client/server boundary
// (coach report, transcript turns, suspend payloads) are imported from the shared
// `wire-contract` module — the single source of truth both this app and the workflow
// core derive from, so a renamed backend field breaks this build instead of silently
// rendering nothing. Only the web-only view types (the flattened report, the stream
// event union, the client interface) are declared here.
import type { InterviewReportView, SuspendPayload } from '../../../shared/wire-contract';

/**
 * The finished interview the report screen renders: the coaching notes and transcript,
 * with the role/company flattened out of `roleContext` for display.
 */
export type InterviewReport = InterviewReportView;

export type {
  AnswerAdvice,
  CoachReport,
  Drill,
  SuspendPayload,
  TranscriptEntry,
} from '../../../shared/wire-contract';

/** How the setup form presented the posting: a link to fetch, or literal pasted text. */
export type PostingInputKind = 'link' | 'paste';

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
  /**
   * Rejoin an in-flight run's stream after a disconnect (a page reload, a dropped
   * connection) and keep streaming where it left off. Settles from the run's
   * persisted state even when the live stream is gone (e.g. the server restarted).
   */
  observe(runId: string): AsyncIterable<InterviewEvent>;
}
