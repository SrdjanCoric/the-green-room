import { MastraClient } from '@mastra/client-js';

import type { StreamChunk } from './chunkInterpreter';
import type { WorkflowOutcome } from './readOutcome';
import { streamToEvents } from './streamToEvents';
import type { EnsembleSelection, InterviewClient, InterviewEvent, StartInterviewInput } from './types';

/** The workflow key the interview run is registered under in `src/mastra/index.ts`. */
const WORKFLOW_ID = 'interviewWorkflow';

/** Run-state fields the authoritative outcome reader needs from `runById`. */
const OUTCOME_FIELDS = ['status', 'result', 'steps'];

type WorkflowRun = Awaited<ReturnType<ReturnType<MastraClient['getWorkflow']>['createRun']>>;

/** A live run plus the request context (model tiers) it was started with. */
interface TrackedRun {
  run: WorkflowRun;
  requestContext?: Record<string, string>;
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

  const fetchOutcome = (runId: string) => async (): Promise<WorkflowOutcome | undefined> => {
    try {
      return (await workflow.runById(runId, {
        fields: OUTCOME_FIELDS,
      })) as WorkflowOutcome;
    } catch {
      return undefined;
    }
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
      resumeData: { answer: string } | { level: string },
    ): AsyncIterable<InterviewEvent> {
      return (async function* (): AsyncGenerator<InterviewEvent> {
        const tracked = runs.get(runId) ?? { run: await workflow.createRun({ runId }) };
        runs.set(runId, tracked);
        const stream = await tracked.run.resumeStream({
          resumeData,
          requestContext: tracked.requestContext,
        });
        yield* consumeStream(stream, fetchOutcome(runId));
      })();
    },
  };
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
