import type { InterviewEvent, InterviewReport, TranscriptEntry } from './types';

/**
 * Where a run is in its lifecycle. These phases move together with the other fields
 * below (the current question, the cue, the error) as one interdependent unit, which
 * is why the interview screen drives them through a reducer rather than scattered
 * `useState` calls.
 */
export type InterviewPhase =
  | 'idle'
  | 'starting'
  | 'streamingQuestion'
  | 'awaitingAnswer'
  | 'awaitingLevel'
  | 'assessing'
  | 'grading'
  | 'report'
  /** A turn failed but the run is alive and suspended — retryable, unlike `error`. */
  | 'turnFailed'
  | 'error';

export interface InterviewState {
  phase: InterviewPhase;
  runId: string | null;
  /** Answered turns, in order. */
  transcript: TranscriptEntry[];
  /** The question currently being streamed or awaiting an answer. */
  currentQuestion: string;
  /** 1-based index of the current question. */
  currentQuestionNumber: number;
  /** The prompt shown when the run suspends for a target level. */
  levelPrompt: string | null;
  /** A between-turns status line ("Choosing the next question…"). */
  cue: string | null;
  /** Raw coach tokens streamed while the report is written, shown before it settles. */
  reportPreview: string;
  /** The finished report, once the run completes. */
  report: InterviewReport | null;
  error: string | null;
}

export const initialInterviewState: InterviewState = {
  phase: 'idle',
  runId: null,
  transcript: [],
  currentQuestion: '',
  currentQuestionNumber: 0,
  levelPrompt: null,
  cue: null,
  reportPreview: '',
  report: null,
  error: null,
};

export type InterviewAction =
  | { type: 'START'; runId: string }
  | { type: 'EVENT'; event: InterviewEvent }
  | { type: 'SUBMIT_ANSWER'; answer: string }
  | { type: 'SUBMIT_LEVEL' }
  | { type: 'RETRY' }
  | { type: 'RESET' };

/** Pure transition function for a single interview run. */
export function interviewReducer(state: InterviewState, action: InterviewAction): InterviewState {
  switch (action.type) {
    case 'START':
      return {
        ...initialInterviewState,
        phase: 'starting',
        runId: action.runId,
      };

    case 'SUBMIT_ANSWER':
      return {
        ...state,
        phase: 'assessing',
        transcript: [...state.transcript, { question: state.currentQuestion, answer: action.answer }],
        currentQuestion: '',
        cue: 'Weighing your answer…',
      };

    case 'SUBMIT_LEVEL':
      return { ...state, phase: 'starting', levelPrompt: null, cue: 'Setting the stage…' };

    case 'RETRY':
      return { ...state, phase: 'assessing', error: null, cue: 'Retrying the turn…' };

    case 'RESET':
      return initialInterviewState;

    case 'EVENT':
      return applyEvent(state, action.event);

    default:
      return state;
  }
}

function applyEvent(state: InterviewState, event: InterviewEvent): InterviewState {
  switch (event.type) {
    case 'cue':
      return { ...state, cue: event.label };

    case 'question-start':
      // A retried interviewer attempt streams the question again from the top;
      // drop the failed attempt's partial text rather than appending to it.
      return { ...state, currentQuestion: '' };

    case 'question-delta':
      return {
        ...state,
        phase: 'streamingQuestion',
        currentQuestion: state.currentQuestion + event.text,
        cue: null,
      };

    case 'report-start':
      return { ...state, reportPreview: '' };

    case 'report-delta':
      return {
        ...state,
        phase: 'grading',
        reportPreview: state.reportPreview + event.text,
        cue: null,
      };

    case 'suspended':
      if (event.suspend.kind === 'level') {
        return { ...state, phase: 'awaitingLevel', levelPrompt: event.suspend.prompt, cue: null };
      }
      if (event.suspend.kind === 'failure') {
        return { ...state, phase: 'turnFailed', error: event.suspend.reason, cue: null };
      }
      return {
        ...state,
        phase: 'awaitingAnswer',
        currentQuestion: event.suspend.question,
        currentQuestionNumber: event.suspend.questionNumber,
        cue: null,
      };

    case 'completed':
      return { ...state, phase: 'report', report: event.report, cue: null };

    case 'failed':
      return { ...state, phase: 'error', error: event.message, cue: null };

    default:
      return state;
  }
}
