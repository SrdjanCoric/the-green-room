import { MastraClient } from '@mastra/client-js';

import type { StreamChunk } from './chunkInterpreter';
import type { WorkflowOutcome } from './readOutcome';
import { loadRunMeta, saveRunMeta } from './sessionStore';
import { streamToEvents } from './streamToEvents';
import type { EnsembleSelection, InterviewClient, InterviewEvent, StartInterviewInput } from './types';

/** The workflow key the interview run is registered under in `src/mastra/index.ts`. */
const WORKFLOW_ID = 'interviewWorkflow';

/**
 * Run-state fields the authoritative outcome reader needs from `runById`. `status` is
 * not listed because the server always includes it (requesting it is rejected as an
 * invalid field name).
 */
const OUTCOME_FIELDS = ['result', 'error', 'steps'];

type WorkflowRun = Awaited<ReturnType<ReturnType<MastraClient['getWorkflow']>['createRun']>>;

/** A live run plus the request context (model tiers) it was started with. */
interface TrackedRun {
  run: WorkflowRun;
  requestContext?: Record<string, string>;
  /**
   * The newest snapshot write time any poll has seen for this run. A resume passes it
   * as the staleness floor, so polls racing the resume can tell the pre-resume
   * suspended state (what the user just answered) apart from real progress.
   */
  lastWriteTime?: number;
}

/**
 * The production {@link InterviewClient}: it drives the interview workflow over
 * `@mastra/client-js` with SSE streaming. `start`/`resume` open a stream that is
 * consumed incrementally and, when it ends, the run's persisted state is read back as
 * the authoritative suspend payload or final report (see {@link streamToEvents}).
 * `observe` rejoins an in-flight run's stream by run id after a disconnect, resuming
 * at the persisted chunk offset. The interview workflow and its agents are unchanged —
 * this is a pure client.
 */
export function createMastraInterviewClient(
  baseUrl: string = window.location.origin,
  storage: Storage = window.localStorage,
): InterviewClient {
  // Same-origin by default: the Vite dev server proxies `/api` and `/prepare-interview`
  // to the Mastra server, so the browser never makes a cross-origin request.
  const client = new MastraClient({ baseUrl });
  const workflow = client.getWorkflow(WORKFLOW_ID);
  // Keep each run's handle and request context so a resume targets the same run and
  // re-supplies the model tiers (Mastra doesn't persist request context across resume).
  const runs = new Map<string, TrackedRun>();

  // The tracked run for a run id, rebuilt from persisted metadata when the in-memory
  // map died with a previous page — the model-tier overrides must survive a reload,
  // or every later resume silently falls back to the server's default models.
  const trackRun = async (runId: string): Promise<TrackedRun> => {
    const existing = runs.get(runId);
    if (existing) return existing;
    const tracked: TrackedRun = {
      run: await workflow.createRun({ runId }),
      requestContext: loadRunMeta(storage, runId).requestContext,
    };
    runs.set(runId, tracked);
    return tracked;
  };

  // The server caches every chunk it delivers over `stream`/`resumeStream`, keyed by
  // run id. Counting what this browser receives over those same transports keeps a
  // persisted mirror of that cache's length, so a reloaded page can rejoin the run's
  // stream at the first chunk it hasn't seen. Each write is one small setItem — cheap
  // enough per chunk, and per-chunk durability is what makes a hard disconnect
  // resumable mid-segment. Observed (rejoined) streams replay without being
  // re-cached, so they must not advance the count.
  const trackOffset = (runId: string): (() => void) => {
    const meta = loadRunMeta(storage, runId);
    return () => {
      meta.offset += 1;
      saveRunMeta(storage, runId, meta);
    };
  };

  // Arm the staleness floor for the duration of a resumed turn: while the turn is in
  // flight, run-state writes at or before `floor` are the pre-resume suspend, not an
  // outcome. Persisted so an observe after a mid-turn reload inherits it.
  const armFloor = (runId: string, floor: number | undefined): void => {
    if (floor === undefined) return;
    saveRunMeta(storage, runId, { ...loadRunMeta(storage, runId), staleAsOf: floor });
  };

  // Disarm once a stream settles (reached its authoritative outcome) — a later
  // observe of the genuinely-suspended run must accept the current state. Also the
  // self-heal for a floor armed by a resume that never reached the server: that
  // observe settles as failed, disarms, and the next attempt recovers the question.
  const disarmFloor = (runId: string): void => {
    const meta = loadRunMeta(storage, runId);
    if (meta.staleAsOf === undefined) return;
    delete meta.staleAsOf;
    saveRunMeta(storage, runId, meta);
  };

  const readRunState = async (runId: string): Promise<WorkflowOutcome | undefined> => {
    try {
      return (await workflow.runById(runId, {
        fields: OUTCOME_FIELDS,
      })) as WorkflowOutcome;
    } catch {
      return undefined;
    }
  };

  // The run's snapshot is only rewritten when the workflow persists new progress, so a
  // poll racing a fresh resume still reads the pre-resume suspended state — the very
  // suspend the user just answered. Anything not newer than `staleAsOf` is not an
  // outcome yet; returning undefined keeps the poll loop waiting. Every read also
  // records its write time on the tracked run, so the next resume knows the floor
  // without an extra request.
  const fetchOutcome =
    (runId: string, staleAsOf?: number) => async (): Promise<WorkflowOutcome | undefined> => {
      const state = await readRunState(runId);
      const written = writeTime(state?.updatedAt);
      if (written !== undefined) {
        const tracked = runs.get(runId);
        if (tracked) tracked.lastWriteTime = Math.max(written, tracked.lastWriteTime ?? 0);
      }
      if (staleAsOf !== undefined && written !== undefined && written <= staleAsOf) {
        return undefined;
      }
      return state;
    };

  return {
    start(input: StartInterviewInput): { runId: string; events: AsyncIterable<InterviewEvent> } {
      const events = (async function* (): AsyncGenerator<InterviewEvent> {
        const requestContext = buildRequestContext(input.ensemble);
        const run = await workflow.createRun({ runId: input.threadId });
        runs.set(run.runId, { run, requestContext });
        // A fresh run starts fresh bookkeeping; the model tiers persist with it so a
        // reloaded page resumes with the same ensemble.
        saveRunMeta(storage, run.runId, { offset: 0, requestContext });
        const stream = await run.stream({
          inputData: buildInputData(input),
          requestContext,
          closeOnSuspend: true,
        });
        yield* consumeStream(stream, fetchOutcome(run.runId), trackOffset(run.runId));
      })();
      // The runId is the thread id we created the run with, so callers can resume it.
      return { runId: input.threadId, events };
    },

    resume(
      runId: string,
      resumeData: { answer: string } | { level: string } | { retry: true },
    ): AsyncIterable<InterviewEvent> {
      return (async function* (): AsyncGenerator<InterviewEvent> {
        const tracked = await trackRun(runId);
        // The staleness floor is the newest write time seen while settling the previous
        // turn. Only a cold resume (nothing seen yet) needs to read it from the server.
        if (tracked.lastWriteTime === undefined) {
          const before = await readRunState(runId);
          tracked.lastWriteTime = writeTime(before?.updatedAt);
        }
        armFloor(runId, tracked.lastWriteTime);
        const stream = await tracked.run.resumeStream({
          resumeData,
          requestContext: tracked.requestContext,
        });
        yield* consumeStream(stream, fetchOutcome(runId, tracked.lastWriteTime), trackOffset(runId));
        disarmFloor(runId);
      })();
    },

    observe(runId: string): AsyncIterable<InterviewEvent> {
      return (async function* (): AsyncGenerator<InterviewEvent> {
        const tracked = await trackRun(runId);
        const meta = loadRunMeta(storage, runId);
        // Replay skips the chunks this browser already received; the server then
        // re-plays the in-flight segment from its start (each segment opens with
        // `workflow-start`/step-start chunks), so the interpreter's start-over events
        // rebuild the current section without duplicating settled content. When the
        // live stream is gone entirely (server restart), the stream closes at once
        // and the run's persisted state below settles the turn. The armed floor
        // carries a mid-turn reload past the pre-resume suspend.
        const stream = await tracked.run.observe({ offset: meta.offset });
        yield* consumeStream(stream, fetchOutcome(runId, meta.staleAsOf));
        disarmFloor(runId);
      })();
    },
  };
}

/** A snapshot write time as epoch millis, from the string or Date the server hands back. */
function writeTime(value: string | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? undefined : time;
}

function buildInputData(input: StartInterviewInput): Record<string, unknown> {
  const data: Record<string, unknown> = {
    cvPath: input.cvPath,
    candidate: input.candidate,
    threadId: input.threadId,
    researchUrls: input.researchUrls,
  };
  if (input.postingText) data.postingText = input.postingText;
  if (input.targetLevel) data.targetLevel = input.targetLevel;
  return data;
}

/**
 * Model-tier overrides for the run, or `undefined` to use the server defaults. The
 * keys match the model-router container keys the agents read (`model.fast` /
 * `model.smart`); values are `provider/model` router strings.
 */
function buildRequestContext(ensemble?: EnsembleSelection): Record<string, string> | undefined {
  if (!ensemble) return undefined;
  return {
    'model.fast': `${ensemble.provider}/${ensemble.fastModel}`,
    'model.smart': `${ensemble.provider}/${ensemble.smartModel}`,
  };
}

/**
 * Convert a client-js SSE stream to domain events, cancelling the stream when the
 * generator finishes. Cancellation matters because {@link streamToEvents} can settle
 * from the run's persisted state and stop reading before the stream closes on its own
 * (a resumed turn that suspends again); cancelling releases the open SSE connection.
 */
async function* consumeStream(
  stream: ReadableStream<unknown>,
  fetchOutcome: () => Promise<WorkflowOutcome | undefined>,
  onChunk?: () => void,
): AsyncGenerator<InterviewEvent> {
  const reader = stream.getReader();
  try {
    yield* streamToEvents(readReader(reader, onChunk), fetchOutcome);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Read a locked stream reader as an async iterable of chunks. */
async function* readReader(
  reader: ReadableStreamDefaultReader<unknown>,
  onChunk?: () => void,
): AsyncGenerator<StreamChunk> {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (!value) continue;
    onChunk?.();
    yield value;
  }
}
