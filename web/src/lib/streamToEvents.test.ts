import { describe, expect, it } from 'vitest';

import type { StreamChunk } from './chunkInterpreter';
import { initialInterviewState, interviewReducer, type InterviewState } from './interviewMachine';
import { streamToEvents } from './streamToEvents';
import type { InterviewEvent } from './types';
import type { WorkflowOutcome } from './readOutcome';

async function* fromArray(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) yield chunk;
}

async function collect(iter: AsyncIterable<InterviewEvent>): Promise<InterviewEvent[]> {
  const out: InterviewEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe('streamToEvents', () => {
  it('emits interpreted cue/question events, then the authoritative suspend outcome', async () => {
    const chunks: StreamChunk[] = [
      { from: 'WORKFLOW', type: 'workflow-step-start', payload: { currentStep: { id: 'interviewTurn' } } },
      { from: 'AGENT', type: 'text-delta', payload: { text: 'Walk me through it.' } },
    ];
    const outcome: WorkflowOutcome = {
      status: 'suspended',
      suspendPayload: { kind: 'question', question: 'Walk me through it.', questionNumber: 1 },
    };

    const events = await collect(streamToEvents(fromArray(chunks), async () => outcome));

    expect(events).toEqual([
      { type: 'cue', label: 'Loading the next question…' },
      { type: 'question-delta', text: 'Walk me through it.' },
      {
        type: 'suspended',
        suspend: { kind: 'question', question: 'Walk me through it.', questionNumber: 1 },
      },
    ]);
  });

  it('yields a failure when the run ends without a readable outcome', async () => {
    const events = await collect(streamToEvents(fromArray([]), async () => undefined, 5));

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({ type: 'failed' });
    if (event?.type === 'failed') expect(event.message).toMatch(/ended/i);
  });

  it('re-polls after the stream closes so a snapshot write that lags the close still settles', async () => {
    // An abnormal close can beat the run's next persist: the first authoritative
    // read comes back empty, but the run is healthy and its state lands shortly after.
    const outcome: WorkflowOutcome = {
      status: 'suspended',
      suspendPayload: { kind: 'question', question: 'Late but fine?', questionNumber: 2 },
    };
    let reads = 0;
    const fetchOutcome = async () => (reads++ < 2 ? undefined : outcome);

    const events = await collect(streamToEvents(fromArray([]), fetchOutcome, 5));

    expect(events).toEqual([
      { type: 'suspended', suspend: { kind: 'question', question: 'Late but fine?', questionNumber: 2 } },
    ]);
  });

  it('drops no chunks when idle polls interleave a slow stream', async () => {
    // Real runs go quiet for seconds while a model call works, then burst. Every idle
    // poll races the stream read — a chunk that resolves a raced-out read must still
    // be delivered, not dropped on the floor.
    async function* slowChunks(): AsyncGenerator<StreamChunk> {
      yield { from: 'WORKFLOW', type: 'workflow-step-start', payload: { currentStep: { id: 'ingest' } } };
      await new Promise((resolve) => setTimeout(resolve, 60));
      yield {
        from: 'USER',
        type: 'workflow-step-output',
        payload: { output: { type: 'ingest-progress', stage: 'role' } },
      };
      await new Promise((resolve) => setTimeout(resolve, 60));
      yield { from: 'WORKFLOW', type: 'workflow-step-start', payload: { currentStep: { id: 'research' } } };
    }
    const outcome: WorkflowOutcome = {
      status: 'suspended',
      suspendPayload: { kind: 'level', prompt: 'What level?' },
    };
    // Not terminal while the stream is alive; the suspend lands only after it closes.
    let closed = false;
    const source = (async function* () {
      yield* slowChunks();
      closed = true;
    })();
    const fetchOutcome = async () => (closed ? outcome : undefined);

    const events = await collect(streamToEvents(source, fetchOutcome, 10));

    expect(events).toEqual([
      { type: 'cue', label: 'Reading your CV' },
      { type: 'cue', label: 'Sizing up the role' },
      { type: 'cue', label: 'Researching the company' },
      { type: 'suspended', suspend: { kind: 'level', prompt: 'What level?' } },
    ]);
  });

  it('rebuilds a rejoined stream without duplicating or dropping content', async () => {
    // The shape an observed (rejoined) stream actually has: a stray tail of cached
    // chunks past the client's offset, then the server re-plays the in-flight segment
    // from its start — `workflow-start`, the step cue, `text-start`, every token —
    // before continuing live. Rendering must come out exactly once.
    const observed: StreamChunk[] = [
      // History tail: a mid-segment token with no step context (the interpreter has
      // no active section yet, so it must not render).
      { from: 'AGENT', type: 'text-delta', payload: { text: 'stale tail ' } },
      // Segment replay from the top.
      { from: 'WORKFLOW', type: 'workflow-start', payload: { workflowId: 'interviewWorkflow' } },
      { from: 'WORKFLOW', type: 'workflow-step-start', payload: { currentStep: { id: 'interviewTurn' } } },
      { from: 'AGENT', type: 'text-start', payload: {} },
      { from: 'AGENT', type: 'text-delta', payload: { text: 'Walk me ' } },
      { from: 'AGENT', type: 'text-delta', payload: { text: 'through it.' } },
    ];
    const outcome: WorkflowOutcome = {
      status: 'suspended',
      suspendPayload: { kind: 'question', question: 'Walk me through it.', questionNumber: 3 },
    };

    const events = await collect(streamToEvents(fromArray(observed), async () => outcome));

    // Reduce the events as the screen would: the reloaded page restored a snapshot
    // holding partial text — the replay must replace it, not append to it.
    let state: InterviewState = { ...initialInterviewState, runId: 'r', currentQuestion: 'Walk me thr' };
    for (const event of events) state = interviewReducer(state, { type: 'EVENT', event });

    expect(state.currentQuestion).toBe('Walk me through it.');
    expect(state.currentQuestionNumber).toBe(3);
    expect(state.phase).toBe('awaitingAnswer');
  });

  it('settles from the authoritative outcome even when the stream never closes', async () => {
    // A resume stream that emits a token then hangs open (no `done`) — the idle
    // watchdog must still detect the suspend from the run's persisted state.
    async function* neverEnds(): AsyncGenerator<StreamChunk> {
      yield { from: 'WORKFLOW', type: 'workflow-step-start', payload: { currentStep: { id: 'interviewTurn' } } };
      await new Promise(() => undefined); // hang forever
    }
    const outcome: WorkflowOutcome = {
      status: 'suspended',
      suspendPayload: { kind: 'question', question: 'Next question?', questionNumber: 2 },
    };

    const events = await collect(streamToEvents(neverEnds(), async () => outcome, 10));

    expect(events).toEqual([
      { type: 'cue', label: 'Loading the next question…' },
      { type: 'suspended', suspend: { kind: 'question', question: 'Next question?', questionNumber: 2 } },
    ]);
  });
});
