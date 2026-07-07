import { describe, expect, it } from 'vitest';

import type { StreamChunk } from './chunkInterpreter';
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
      { type: 'cue', label: 'Writing the question…' },
      { type: 'question-delta', text: 'Walk me through it.' },
      {
        type: 'suspended',
        suspend: { kind: 'question', question: 'Walk me through it.', questionNumber: 1 },
      },
    ]);
  });

  it('yields a failure when the run ends without a readable outcome', async () => {
    const events = await collect(streamToEvents(fromArray([]), async () => undefined));

    expect(events).toEqual([{ type: 'failed', message: expect.stringMatching(/ended/i) }]);
  });

  it('settles from the authoritative outcome even when the stream never closes', async () => {
    // A resume stream that emits a token then hangs open (no `done`) — the idle
    // watchdog must still detect the suspend from the run's persisted state.
    async function* neverEnds(): AsyncGenerator<StreamChunk> {
      yield { from: 'WORKFLOW', type: 'workflow-step-start', payload: { currentStep: { id: 'interviewTurn' } } };
      await new Promise(() => {}); // hang forever
    }
    const outcome: WorkflowOutcome = {
      status: 'suspended',
      suspendPayload: { kind: 'question', question: 'Next question?', questionNumber: 2 },
    };

    const events = await collect(streamToEvents(neverEnds(), async () => outcome, 10));

    expect(events).toEqual([
      { type: 'cue', label: 'Writing the question…' },
      { type: 'suspended', suspend: { kind: 'question', question: 'Next question?', questionNumber: 2 } },
    ]);
  });
});
