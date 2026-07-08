import { useCallback, useEffect, useReducer, useRef } from 'react';

import {
  type InterviewState,
  initialInterviewState,
  interviewReducer,
} from '../lib/interviewMachine';
import { clearRunMeta, clearSession, loadSession, saveSession } from '../lib/sessionStore';
import type {
  InterviewClient,
  InterviewEvent,
  InterviewReport,
  StartInterviewInput,
} from '../lib/types';

/** Fired when a run finishes, from the stream-consumption path (not a render effect). */
export type OnCompleted = (report: InterviewReport, runId: string) => void;

/** Fired when a run settles as failed — the hard kind, not a retryable turn failure. */
export type OnFailed = (runId: string) => void;

export interface UseInterviewOptions {
  onCompleted?: OnCompleted;
  onFailed?: OnFailed;
  storage?: Storage;
}

export interface UseInterview {
  state: InterviewState;
  /** Start a fresh run and begin streaming toward the first question. */
  start: (input: StartInterviewInput) => void;
  /**
   * Rejoin an in-flight run after a reload or restored connection: restore its saved
   * session snapshot and observe the run's live stream where it left off.
   */
  reconnect: (runId: string) => void;
  /** Answer the current question and stream toward the next one (or the report). */
  submitAnswer: (answer: string) => void;
  /** Choose the target level when the run suspended to ask for it. */
  submitLevel: (level: string) => void;
  /** Report that the goodbye finished typing out on screen. */
  markClosingRevealed: () => void;
  /** Re-run a failed turn when the run suspended with a failure payload. */
  retry: () => void;
}

/**
 * Drive one interview run: it owns the {@link interviewReducer} state and consumes the
 * {@link InterviewClient}'s streamed events into it. The client is injected so the
 * screens can be exercised against a scripted mock without a live server.
 */
export function useInterview(
  client: InterviewClient,
  { onCompleted, onFailed, storage = window.localStorage }: UseInterviewOptions = {},
): UseInterview {
  const [state, dispatch] = useReducer(interviewReducer, initialInterviewState);
  const runIdRef = useRef<string | null>(null);
  // Each start/reconnect begins a new consumption generation; a stream from a
  // superseded generation must stop dispatching, or two runs' events would
  // interleave into one reducer (and a stale completion could credit the wrong run).
  const generationRef = useRef(0);
  // Latest-callback refs so consuming the stream never closes over stale handlers.
  const onCompletedRef = useRef(onCompleted);
  const onFailedRef = useRef(onFailed);
  useEffect(() => {
    onCompletedRef.current = onCompleted;
    onFailedRef.current = onFailed;
  }, [onCompleted, onFailed]);

  // Keep the run's session snapshot in step with the live state so a reload can
  // restore the settled transcript before rejoining the stream. Persisting only at
  // phase transitions keeps this off the token hot path — everything durable
  // (transcript, the settled question, the level prompt) lands with a phase change,
  // while in-flight text is rebuilt from the observed stream's replay, not from
  // here. A finished run's snapshot and stream bookkeeping are dropped — the cached
  // report takes over.
  const persistedPhaseRef = useRef<string | null>(null);
  useEffect(() => {
    const { runId, phase } = state;
    if (!runId || phase === 'idle') return;
    const marker = `${runId}:${phase}`;
    if (persistedPhaseRef.current === marker) return;
    persistedPhaseRef.current = marker;
    if (phase === 'report') {
      clearSession(storage, runId);
      clearRunMeta(storage, runId);
      return;
    }
    saveSession(storage, runId, state);
  }, [state, storage]);

  const consume = useCallback(
    async (
      events: AsyncIterable<InterviewEvent>,
      generation: number,
      runId: string,
      canRejoin: boolean,
    ) => {
      try {
        for await (const event of events) {
          if (generationRef.current !== generation) return;
          dispatch({ type: 'EVENT', event });
          if (event.type === 'completed') onCompletedRef.current?.(event.report, runId);
          if (event.type === 'failed') onFailedRef.current?.(runId);
        }
      } catch (error) {
        if (generationRef.current !== generation) return;
        // A dropped transport mid-stream: rejoin the run's stream in place rather
        // than declaring the run dead — the run is still working server-side. One
        // rejoin per failure; if the rejoin itself dies (genuinely offline), settle
        // into the error state and let the online listener try again.
        if (canRejoin) {
          dispatch({ type: 'EVENT', event: { type: 'cue', label: 'Reconnecting…' } });
          void consume(client.observe(runId), generation, runId, false);
          return;
        }
        dispatch({
          type: 'EVENT',
          event: { type: 'failed', message: error instanceof Error ? error.message : String(error) },
        });
        onFailedRef.current?.(runId);
      }
    },
    [client],
  );

  const start = useCallback(
    (input: StartInterviewInput) => {
      const { runId, events } = client.start(input);
      runIdRef.current = runId;
      const generation = ++generationRef.current;
      dispatch({ type: 'START', runId });
      void consume(events, generation, runId, true);
    },
    [client, consume],
  );

  const reconnect = useCallback(
    (runId: string) => {
      runIdRef.current = runId;
      const generation = ++generationRef.current;
      dispatch({ type: 'RECONNECT', runId, snapshot: loadSession(storage, runId) });
      // The observe stream is itself the rejoin, so a failure here settles as an
      // error; the online listener (or the playbill) retries it.
      void consume(client.observe(runId), generation, runId, false);
    },
    [client, consume, storage],
  );

  // A run that died on a dead connection rejoins by itself when the connection
  // returns. The listener exists only while the run sits in the error state.
  useEffect(() => {
    if (state.phase !== 'error' || !state.runId) return;
    const runId = state.runId;
    const onOnline = () => reconnect(runId);
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [state.phase, state.runId, reconnect]);

  const submitAnswer = useCallback(
    (answer: string) => {
      const runId = runIdRef.current;
      if (!runId) return;
      dispatch({ type: 'SUBMIT_ANSWER', answer });
      void consume(client.resume(runId, { answer }), generationRef.current, runId, true);
    },
    [client, consume],
  );

  const submitLevel = useCallback(
    (level: string) => {
      const runId = runIdRef.current;
      if (!runId) return;
      dispatch({ type: 'SUBMIT_LEVEL' });
      void consume(client.resume(runId, { level }), generationRef.current, runId, true);
    },
    [client, consume],
  );

  const markClosingRevealed = useCallback(() => {
    dispatch({ type: 'CLOSING_REVEALED' });
  }, []);

  const retry = useCallback(() => {
    const runId = runIdRef.current;
    if (!runId) return;
    dispatch({ type: 'RETRY' });
    void consume(client.resume(runId, { retry: true }), generationRef.current, runId, true);
  }, [client, consume]);

  return { state, start, reconnect, submitAnswer, submitLevel, markClosingRevealed, retry };
}
