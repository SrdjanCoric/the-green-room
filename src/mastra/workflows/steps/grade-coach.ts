import { createStep } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';

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
): string {
  return (
    `The target level for this interview is ${targetLevel}; pitch your advice to it.\n` +
    `Here is the finished interview between the <transcript> tags.\n<transcript>\n${neutralizeFences(
      renderNumberedTranscript(transcript),
    )}\n</transcript>\n` +
    `Here is the grader's read of each answer between the <grades> tags.\n<grades>\n${neutralizeFences(
      renderGradeForCoach(grade),
    )}\n</grades>\n` +
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
  return async (transcript, grade, targetLevel) => {
    if (grade.scores.length === 0) {
      return coachReportSchema.parse({ summary: '', answerAdvice: [], drills: [], studyPlan: '' });
    }

    // Coaching is keyed by the quoted question, not a turn index, so there is no
    // cross-turn contract to validate — only the structured shape.
    return structuredCall(
      agent,
      buildCoachPrompt(transcript, grade, targetLevel),
      coachReportSchema,
      requestContext,
      { description: 'coach', attempts: maxAttempts },
    );
  };
}

export const gradeStep = createStep({
  id: 'grade',
  inputSchema: closedInterviewStateSchema,
  outputSchema: gradedInterviewStateSchema,
  execute: async ({ inputData, mastra, requestContext }) => {
    const grade = await createSessionGrader(mastra.getAgent('grader'), requestContext)(
      inputData.transcript,
      inputData.targetLevel,
    );
    return { ...inputData, grade };
  },
});

export const coachStep = createStep({
  id: 'coach',
  inputSchema: gradedInterviewStateSchema,
  outputSchema: coachedInterviewStateSchema,
  execute: async ({ inputData, mastra, requestContext }) => {
    const coaching = await createCoachReporter(mastra.getAgent('coach'), requestContext)(
      inputData.transcript,
      inputData.grade,
      inputData.targetLevel,
    );
    return { ...inputData, coaching };
  },
});
