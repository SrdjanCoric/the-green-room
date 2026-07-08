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
  /** The interviewer is saying goodbye — the streamed closing line, before grading. */
  | 'closing'
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
  /** The interviewer's streamed goodbye, shown as their final line before grading. */
  closingMessage: string;
  /**
   * Whether the goodbye has fully typed out on screen. The screen reports it (the
   * reveal is UI pacing); holding it here lets the grading gate and the report
   * navigation survive a remount instead of retyping and re-hiding.
   */
  closingRevealed: boolean;
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
  closingMessage: '',
  closingRevealed: false,
  reportPreview: '',
  report: null,
  error: null,
};

export type InterviewAction =
  | { type: 'START'; runId: string }
  /** Rejoin an in-flight run after a reload, restoring its saved snapshot if any. */
  | { type: 'RECONNECT'; runId: string; snapshot: InterviewState | null }
  | { type: 'EVENT'; event: InterviewEvent }
  | { type: 'SUBMIT_ANSWER'; answer: string }
  | { type: 'SUBMIT_LEVEL' }
  /** The screen finished typing the goodbye out; grading may take the stage. */
  | { type: 'CLOSING_REVEALED' }
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

    // The snapshot restores the settled transcript; the in-flight section is rebuilt
    // by the observed stream's replay, so hydrating partial text is safe either way.
    // A cold reconnect (snapshot lost) still works — the stream and the run's
    // persisted state carry the current turn; only past turns' display is gone.
    // A snapshot saved in the error phase rehydrates as a reconnect in progress:
    // re-rendering the stale error would hide the very rejoin the user asked for.
    case 'RECONNECT': {
      if (!action.snapshot) {
        return { ...initialInterviewState, phase: 'starting', runId: action.runId, cue: 'Reconnecting…' };
      }
      const snapshot = { ...action.snapshot, runId: action.runId };
      if (snapshot.phase === 'error') {
        return { ...snapshot, phase: 'starting', error: null, cue: 'Reconnecting…' };
      }
      return snapshot;
    }

    case 'SUBMIT_ANSWER':
      return {
        ...state,
        phase: 'assessing',
        transcript: [...state.transcript, { question: state.currentQuestion, answer: action.answer }],
        currentQuestion: '',
        cue: 'Weighing your answer…',
      };

    // Setup finished before the level question, so this stays on the interview scene
    // (the between-turns cue), never back on the loading screen.
    case 'SUBMIT_LEVEL':
      return { ...state, phase: 'assessing', levelPrompt: null, cue: 'Choosing the next question…' };

    case 'CLOSING_REVEALED':
      return { ...state, closingRevealed: true };

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

    case 'closing-start':
      // A retried goodbye streams again from the top; drop the failed attempt's text.
      return { ...state, closingMessage: '', closingRevealed: false };

    case 'closing-delta':
      // New text re-arms the reveal: a premature catch-up mustn't leave it settled.
      return {
        ...state,
        phase: 'closing',
        closingMessage: state.closingMessage + event.text,
        closingRevealed: false,
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
      // A restored snapshot can hold an answer the run never received (the page
      // died between submit and the resume reaching the server). If the run is
      // still suspended on that same question, the trailing entry is that lost
      // answer — drop it so the re-answered turn isn't recorded twice.
      return {
        ...state,
        phase: 'awaitingAnswer',
        transcript:
          state.transcript.at(-1)?.question === event.suspend.question
            ? state.transcript.slice(0, -1)
            : state.transcript,
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
