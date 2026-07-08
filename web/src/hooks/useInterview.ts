import { useCallback, useEffect, useReducer, useRef } from 'react';

import {
  type InterviewState,
  initialInterviewState,
  interviewReducer,
} from '../lib/interviewMachine';
import type {
  InterviewClient,
  InterviewEvent,
  InterviewReport,
  StartInterviewInput,
} from '../lib/types';

/** Fired when a run finishes, from the stream-consumption path (not a render effect). */
export type OnCompleted = (report: InterviewReport, runId: string) => void;

export interface UseInterview {
  state: InterviewState;
  /** Start a fresh run and begin streaming toward the first question. */
  start: (input: StartInterviewInput) => void;
  /** Answer the current question and stream toward the next one (or the report). */
  submitAnswer: (answer: string) => void;
  /** Choose the target level when the run suspended to ask for it. */
  submitLevel: (level: string) => void;
  /** Re-run a failed turn when the run suspended with a failure payload. */
  retry: () => void;
}

/**
 * Drive one interview run: it owns the {@link interviewReducer} state and consumes the
 * {@link InterviewClient}'s streamed events into it. The client is injected so the
 * screens can be exercised against a scripted mock without a live server.
 */
export function useInterview(client: InterviewClient, onCompleted?: OnCompleted): UseInterview {
  const [state, dispatch] = useReducer(interviewReducer, initialInterviewState);
  const runIdRef = useRef<string | null>(null);
  // Latest-callback ref so consuming the stream never closes over a stale handler.
  const onCompletedRef = useRef(onCompleted);
  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  const consume = useCallback(async (events: AsyncIterable<InterviewEvent>) => {
    try {
      for await (const event of events) {
        dispatch({ type: 'EVENT', event });
        if (event.type === 'completed' && runIdRef.current) {
          onCompletedRef.current?.(event.report, runIdRef.current);
        }
      }
    } catch (error) {
      dispatch({
        type: 'EVENT',
        event: { type: 'failed', message: error instanceof Error ? error.message : String(error) },
      });
    }
  }, []);

  const start = useCallback(
    (input: StartInterviewInput) => {
      const { runId, events } = client.start(input);
      runIdRef.current = runId;
      dispatch({ type: 'START', runId });
      void consume(events);
    },
    [client, consume],
  );

  const submitAnswer = useCallback(
    (answer: string) => {
      const runId = runIdRef.current;
      if (!runId) return;
      dispatch({ type: 'SUBMIT_ANSWER', answer });
      void consume(client.resume(runId, { answer }));
    },
    [client, consume],
  );

  const submitLevel = useCallback(
    (level: string) => {
      const runId = runIdRef.current;
      if (!runId) return;
      dispatch({ type: 'SUBMIT_LEVEL' });
      void consume(client.resume(runId, { level }));
    },
    [client, consume],
  );

  const retry = useCallback(() => {
    const runId = runIdRef.current;
    if (!runId) return;
    dispatch({ type: 'RETRY' });
    void consume(client.resume(runId, { retry: true }));
  }, [client, consume]);

  return { state, start, submitAnswer, submitLevel, retry };
}
