import { createStep } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';

import {
  computeSessionSummary,
  parseCandidateWorkingMemory,
  renderPriorSessions,
  upsertSessionSummary,
  type SessionSummary,
} from '../../interview/coaching-ledger';
import { candidateMemory } from '../../memory';
import { neutralizeFences } from '../../prompt-safety';
import { structuredCall, type StructuredGenerator } from '../../structured-call';
import {
  coachReportSchema,
  sessionGradeForTranscriptSchema,
  type CoachReport,
  type SessionGrade,
} from '../../schemas/coach-report';
import type { TranscriptEntry } from '../../schemas/interview';
import {
  closedInterviewStateSchema,
  coachedInterviewStateSchema,
  gradedInterviewStateSchema,
} from '../interview-state';

export type SessionGrader = (
  transcript: TranscriptEntry[],
  targetLevel: string,
) => Promise<SessionGrade>;

export type CoachReporter = (
  transcript: TranscriptEntry[],
  grade: SessionGrade,
  targetLevel: string,
  priorSessions?: SessionSummary[],
) => Promise<CoachReport>;

function renderNumberedTranscript(transcript: TranscriptEntry[]): string {
  return transcript
    .map(
      (turn, index) =>
        `Turn ${index + 1}\nQ: ${turn.question}\nA: ${turn.answer}`,
    )
    .join('\n\n');
}

export function renderGradeForCoach(grade: SessionGrade): string {
  return grade.scores
    .map((score) => {
      const missing =
        score.weakOrMissing.length > 0 ? `\nweak or missing: ${score.weakOrMissing.join(', ')}` : '';
      const gap = score.gap.trim() ? `\ngap: ${score.gap}` : '';
      return (
        `Answer ${score.turnIndex + 1}: ${score.score}/5\n` +
        `question: ${score.question}\n` +
        `specificity: ${score.specificity}\n` +
        `ownership: ${score.ownership}` +
        missing +
        gap
      );
    })
    .join('\n\n');
}

export function buildGraderPrompt(transcript: TranscriptEntry[], targetLevel: string): string {
  return (
    `The target level for this interview is ${targetLevel}; grade every answer against it.\n` +
    `Here is the finished interview between the <transcript> tags. Score each answer the candidate gave.\n<transcript>\n${neutralizeFences(
      renderNumberedTranscript(transcript),
    )}\n</transcript>`
  );
}

export function buildCoachPrompt(
  transcript: TranscriptEntry[],
  grade: SessionGrade,
  targetLevel: string,
  priorSessions: SessionSummary[] = [],
): string {
  // A first-session candidate gets no prior-sessions section at all — the prompt must
  // not invent history. Returning candidates get the ledger, fenced, with explicit
  // repeat-callout instructions.
  const priorBlock =
    priorSessions.length > 0
      ? `This candidate has practiced before. Here are their previous sessions between the <prior_sessions> tags, oldest first. ` +
        `Where this session repeats a weakness from an earlier one, call the repeat out explicitly — name what they were advised last time and where it recurred (for example: "last session you were advised to end on a number; it recurred on question 2") — and make the fix firmer.\n` +
        `<prior_sessions>\n${neutralizeFences(renderPriorSessions(priorSessions))}\n</prior_sessions>\n`
      : '';

  return (
    `The target level for this interview is ${targetLevel}; pitch your advice to it.\n` +
    `Here is the finished interview between the <transcript> tags.\n<transcript>\n${neutralizeFences(
      renderNumberedTranscript(transcript),
    )}\n</transcript>\n` +
    `Here is the grader's read of each answer between the <grades> tags.\n<grades>\n${neutralizeFences(
      renderGradeForCoach(grade),
    )}\n</grades>\n` +
    priorBlock +
    'Coach this candidate now.'
  );
}

export function createSessionGrader(
  agent: StructuredGenerator,
  requestContext: RequestContext,
  maxAttempts = 3,
): SessionGrader {
  return async (transcript, targetLevel) => {
    if (transcript.length === 0) {
      return sessionGradeForTranscriptSchema(0).parse({ scores: [], skipped: [] });
    }

    // The per-transcript schema enforces the coverage contract — every turn scored
    // exactly once — so a grade that misses or doubles a turn is retried with the
    // violation spelled out, not accepted.
    const schema = sessionGradeForTranscriptSchema(transcript.length);
    return structuredCall(agent, buildGraderPrompt(transcript, targetLevel), schema, requestContext, {
      description: 'grader',
      attempts: maxAttempts,
    });
  };
}

export function createCoachReporter(
  agent: StructuredGenerator,
  requestContext: RequestContext,
  maxAttempts = 3,
): CoachReporter {
  return async (transcript, grade, targetLevel, priorSessions = []) => {
    if (grade.scores.length === 0) {
      return coachReportSchema.parse({ summary: '', answerAdvice: [], drills: [], studyPlan: '' });
    }

    // Coaching is keyed by the quoted question, not a turn index, so there is no
    // cross-turn contract to validate — only the structured shape.
    return structuredCall(
      agent,
      buildCoachPrompt(transcript, grade, targetLevel, priorSessions),
      coachReportSchema,
      requestContext,
      { description: 'coach', attempts: maxAttempts },
    );
  };
}

/** The slice of the memory API the coach step's ledger read/write depends on. */
export interface CandidateLedgerStore {
  getWorkingMemory(args: { threadId: string; resourceId?: string }): Promise<string | null>;
  updateWorkingMemory(args: {
    threadId: string;
    resourceId?: string;
    workingMemory: string;
  }): Promise<void>;
}

/**
 * The candidate's prior coached sessions, for the coach prompt — every ledger entry
 * except the current run's own (a `recoach` replay must not read its own session
 * back as history).
 */
export async function readPriorSessions(params: {
  memory: CandidateLedgerStore;
  candidateId: string;
  threadId: string;
  runId: string;
}): Promise<SessionSummary[]> {
  const stored = await params.memory.getWorkingMemory({
    resourceId: params.candidateId,
    threadId: params.threadId,
  });
  const record = parseCandidateWorkingMemory(stored);
  return (record?.sessions ?? []).filter((session) => session.runId !== params.runId);
}

/**
 * Distill the coached session and upsert it into the candidate's ledger. Reads the
 * stored record fresh (rather than reusing the pre-coach read) to shrink the window
 * in which another session's write could be overwritten, and upserts by `runId` so a
 * `recoach` replay updates its own entry instead of double-appending. This is still a
 * plain read-modify-write: two sessions for the same candidate finishing at the same
 * moment can drop one ledger entry. Acceptable for the single-operator setup; true
 * concurrency safety needs storage-level compare-and-swap.
 */
export async function recordSessionInLedger(params: {
  memory: CandidateLedgerStore;
  candidateId: string;
  threadId: string;
  runId: string;
  date: string;
  roleContext: Parameters<typeof computeSessionSummary>[0]['roleContext'];
  transcriptLength: number;
  grade: SessionGrade;
  coaching: CoachReport;
}): Promise<void> {
  const stored = await params.memory.getWorkingMemory({
    resourceId: params.candidateId,
    threadId: params.threadId,
  });
  const record = parseCandidateWorkingMemory(stored);
  if (!record) return;

  const summary = computeSessionSummary({
    runId: params.runId,
    date: params.date,
    roleContext: params.roleContext,
    transcriptLength: params.transcriptLength,
    grade: params.grade,
    coaching: params.coaching,
  });

  await params.memory.updateWorkingMemory({
    resourceId: params.candidateId,
    threadId: params.threadId,
    workingMemory: JSON.stringify({
      profile: record.profile,
      sessions: upsertSessionSummary(record.sessions, summary),
    }),
  });
}

export function createGradeStep(options: { grader?: StructuredGenerator } = {}) {
  return createStep({
    id: 'grade',
    inputSchema: closedInterviewStateSchema,
    outputSchema: gradedInterviewStateSchema,
    execute: async ({ inputData, mastra, requestContext }) => {
      const grader = options.grader ?? mastra.getAgent('grader');
      const grade = await createSessionGrader(grader, requestContext)(
        inputData.transcript,
        inputData.targetLevel,
      );
      return { ...inputData, grade };
    },
  });
}

/** The production grade step, backed by the registered grader agent. */
export const gradeStep = createGradeStep();

export function createCoachStep(
  options: { coach?: StructuredGenerator; memory?: CandidateLedgerStore } = {},
) {
  return createStep({
    id: 'coach',
    inputSchema: gradedInterviewStateSchema,
    outputSchema: coachedInterviewStateSchema,
    execute: async ({ inputData, mastra, requestContext, runId }) => {
      const ledgerKey = {
        memory: options.memory ?? candidateMemory,
        candidateId: inputData.candidateId,
        threadId: inputData.threadId,
        runId,
      };
      // Prior sessions are optional prompt garnish: like the ledger write below, a
      // storage fault here must not fail a finished interview.
      let priorSessions: SessionSummary[] = [];
      try {
        priorSessions = await readPriorSessions(ledgerKey);
      } catch (error) {
        mastra.getLogger()?.warn('Could not read prior sessions; coaching without history.', {
          error,
        });
      }

      const coach = options.coach ?? mastra.getAgent('coach');
      const coaching = await createCoachReporter(coach, requestContext)(
        inputData.transcript,
        inputData.grade,
        inputData.targetLevel,
        priorSessions,
      );

      // The ledger is auxiliary to the coaching itself: a write fault must not discard
      // a finished coach report, so it degrades to a logged warning.
      try {
        await recordSessionInLedger({
          ...ledgerKey,
          date: new Date().toISOString(),
          roleContext: inputData.roleContext,
          transcriptLength: inputData.transcript.length,
          grade: inputData.grade,
          coaching,
        });
      } catch (error) {
        mastra.getLogger()?.warn('Could not record the session in the coaching ledger.', { error });
      }

      return { ...inputData, coaching };
    },
  });
}

/** The production coach step, backed by the registered coach agent. */
export const coachStep = createCoachStep();
