import { createChunkInterpreter, type StreamChunk } from './chunkInterpreter';
import { readOutcome, type WorkflowOutcome } from './readOutcome';
import type { InterviewEvent } from './types';

/** Default silence, in ms, after which the run's persisted state is polled. */
const DEFAULT_IDLE_MS = 1500;

/**
 * Extra polls (spaced `idleMs` apart) after the stream ends before giving up. An
 * abnormal stream close can beat the run's next snapshot write — the run is healthy,
 * its state just hasn't landed yet — so one immediate read is not enough evidence
 * to declare the run over without a result.
 */
const FINAL_POLL_ATTEMPTS = 8;

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

  // One in-flight read survives across idle races. A fresh `iterator.next()` per
  // race would leak the raced-out read: its promise still resolves with a real chunk
  // later, but nothing would await it — every model-call silence would then swallow
  // the chunks that follow it (live tokens, progress cues) on the floor.
  let pendingRead: Promise<IteratorResult<StreamChunk>> | null = null;

  for (;;) {
    let timer: ReturnType<typeof setTimeout>;
    const idle = new Promise<typeof IDLE>((resolve) => {
      timer = setTimeout(() => resolve(IDLE), idleMs);
    });

    let raced: IteratorResult<StreamChunk> | typeof IDLE;
    try {
      pendingRead ??= iterator.next();
      raced = await Promise.race([pendingRead, idle]);
    } finally {
      clearTimeout(timer!);
    }

    if (raced === IDLE) {
      const outcome = await fetchOutcome();
      if (readOutcome(outcome)) {
        terminal = outcome;
        break;
      }
      continue; // Not terminal yet — the pending read stays armed for the next chunk.
    }

    pendingRead = null;
    if (raced.done) break;
    const event = interpreter.next(raced.value);
    if (event) yield event;
  }

  let outcome = readOutcome(terminal ?? (await fetchOutcome()));
  for (let attempt = 0; !outcome && attempt < FINAL_POLL_ATTEMPTS; attempt++) {
    await delay(idleMs);
    outcome = readOutcome(await fetchOutcome());
  }
  yield outcome ?? { type: 'failed', message: 'The interview run ended without a result.' };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
