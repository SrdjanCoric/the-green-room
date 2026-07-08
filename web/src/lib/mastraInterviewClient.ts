import { MastraClient } from '@mastra/client-js';

import type { StreamChunk } from './chunkInterpreter';
import type { WorkflowOutcome } from './readOutcome';
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
 * the authoritative suspend payload or final report (see {@link streamToEvents}). The
 * interview workflow and its agents are unchanged — this is a pure client.
 */
export function createMastraInterviewClient(
  baseUrl: string = window.location.origin,
): InterviewClient {
  // Same-origin by default: the Vite dev server proxies `/api` and `/prepare-interview`
  // to the Mastra server, so the browser never makes a cross-origin request.
  const client = new MastraClient({ baseUrl });
  const workflow = client.getWorkflow(WORKFLOW_ID);
  // Keep each run's handle and request context so a resume targets the same run and
  // re-supplies the model tiers (Mastra doesn't persist request context across resume).
  const runs = new Map<string, TrackedRun>();

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
        const stream = await run.stream({
          inputData: buildInputData(input),
          requestContext,
          closeOnSuspend: true,
        });
        yield* consumeStream(stream, fetchOutcome(run.runId));
      })();
      // The runId is the thread id we created the run with, so callers can resume it.
      return { runId: input.threadId, events };
    },

    resume(
      runId: string,
      resumeData: { answer: string } | { level: string } | { retry: true },
    ): AsyncIterable<InterviewEvent> {
      return (async function* (): AsyncGenerator<InterviewEvent> {
        const tracked = runs.get(runId) ?? { run: await workflow.createRun({ runId }) };
        runs.set(runId, tracked);
        // The staleness floor is the newest write time seen while settling the previous
        // turn. Only a cold resume (nothing seen yet) needs to read it from the server.
        if (tracked.lastWriteTime === undefined) {
          const before = await readRunState(runId);
          tracked.lastWriteTime = writeTime(before?.updatedAt);
        }
        const stream = await tracked.run.resumeStream({
          resumeData,
          requestContext: tracked.requestContext,
        });
        yield* consumeStream(stream, fetchOutcome(runId, tracked.lastWriteTime));
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
): AsyncGenerator<InterviewEvent> {
  const reader = stream.getReader();
  try {
    yield* streamToEvents(readReader(reader), fetchOutcome);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Read a locked stream reader as an async iterable of chunks. */
async function* readReader(reader: ReadableStreamDefaultReader<unknown>): AsyncGenerator<StreamChunk> {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value) yield value as StreamChunk;
  }
}
