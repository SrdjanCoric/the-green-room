import { createChunkInterpreter, type StreamChunk } from './chunkInterpreter';
import { readOutcome, type WorkflowOutcome } from './readOutcome';
import type { InterviewEvent } from './types';

/** Default silence, in ms, after which the run's persisted state is polled. */
const DEFAULT_IDLE_MS = 1500;

const IDLE = Symbol('idle');

/**
 * Turn one Mastra workflow stream into the domain events the interview screen
 * consumes. Interpreted cue/token events are emitted live as chunks arrive; the run's
 * persisted state — fetched via `fetchOutcome` — is the authoritative source for the
 * suspend payload or final report.
 *
 * The stream is not trusted to close on suspend: `resumeStream()` has no
 * `closeOnSuspend`, so a resumed turn that suspends again can leave the stream open. A
 * silence longer than `idleMs` therefore triggers an authoritative poll, and the run
 * settles the moment its state is terminal — the UI never hangs waiting for a stream
 * that will not end.
 */
export async function* streamToEvents(
  chunks: AsyncIterable<StreamChunk>,
  fetchOutcome: () => Promise<WorkflowOutcome | undefined>,
  idleMs: number = DEFAULT_IDLE_MS,
): AsyncGenerator<InterviewEvent> {
  const interpreter = createChunkInterpreter();
  const iterator = chunks[Symbol.asyncIterator]();
  let terminal: WorkflowOutcome | undefined;

  for (;;) {
    let timer: ReturnType<typeof setTimeout>;
    const idle = new Promise<typeof IDLE>((resolve) => {
      timer = setTimeout(() => resolve(IDLE), idleMs);
    });

    let raced: IteratorResult<StreamChunk> | typeof IDLE;
    try {
      raced = await Promise.race([iterator.next(), idle]);
    } finally {
      clearTimeout(timer!);
    }

    if (raced === IDLE) {
      const outcome = await fetchOutcome();
      if (readOutcome(outcome)) {
        terminal = outcome;
        break;
      }
      continue; // Not terminal yet — keep waiting for chunks.
    }

    if (raced.done) break;
    const event = interpreter.next(raced.value);
    if (event) yield event;
  }

  const outcome = readOutcome(terminal ?? (await fetchOutcome()));
  yield outcome ?? { type: 'failed', message: 'The interview run ended without a result.' };
}
