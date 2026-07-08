import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StreamChunk } from './chunkInterpreter';
import { createMastraInterviewClient } from './mastraInterviewClient';
import { loadStreamOffset } from './sessionStore';
import type { InterviewEvent, StartInterviewInput } from './types';

const { workflowMock } = vi.hoisted(() => ({
  workflowMock: {
    createRun: vi.fn(),
    runById: vi.fn(),
  },
}));

vi.mock('@mastra/client-js', () => ({
  MastraClient: class {
    getWorkflow() {
      return workflowMock;
    }
  },
}));

const RUN_ID = 'run-observe-1';

const startInput: StartInterviewInput = {
  cvPath: '/tmp/cv.pdf',
  researchUrls: [],
  candidate: 'cand-1',
  threadId: RUN_ID,
};

/** The suspended state the poll settles on once a stream segment ends. */
const suspendedOutcome = {
  status: 'suspended',
  updatedAt: new Date('2026-07-08T10:00:00Z'),
  suspendPayload: { kind: 'question', question: 'Full question?', questionNumber: 1 },
};

function chunkStream(chunks: StreamChunk[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** A question segment as the server streams it: step cue, reply start, tokens. */
function questionSegment(text: string): StreamChunk[] {
  return [
    { from: 'WORKFLOW', type: 'workflow-start', payload: { workflowId: 'interviewWorkflow' } },
    { from: 'WORKFLOW', type: 'workflow-step-start', payload: { currentStep: { id: 'interviewTurn' } } },
    { from: 'AGENT', type: 'text-start', payload: {} },
    { from: 'AGENT', type: 'text-delta', payload: { text } },
  ];
}

async function collect(iter: AsyncIterable<InterviewEvent>): Promise<InterviewEvent[]> {
  const out: InterviewEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

function fakeRun(overrides: Partial<Record<'stream' | 'resumeStream' | 'observe', unknown>> = {}) {
  return {
    runId: RUN_ID,
    stream: vi.fn(async () => chunkStream(questionSegment('Full question?'))),
    resumeStream: vi.fn(async () => chunkStream(questionSegment('Next question?'))),
    observe: vi.fn(async () => chunkStream(questionSegment('Full question?'))),
    ...overrides,
  };
}

describe('createMastraInterviewClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    // Each poll sees a newer snapshot write, as it would after real progress —
    // resume()'s staleness floor treats a non-advancing write time as pre-resume state.
    let writeMs = new Date('2026-07-08T10:00:00Z').getTime();
    workflowMock.runById.mockImplementation(async () => ({
      ...suspendedOutcome,
      updatedAt: new Date((writeMs += 1000)),
    }));
  });

  it('start() persists the count of streamed chunks so a reload can rejoin at that offset', async () => {
    const run = fakeRun();
    workflowMock.createRun.mockResolvedValue(run);
    const client = createMastraInterviewClient('http://localhost', window.localStorage);

    const { events } = client.start(startInput);
    await collect(events);

    // The question segment streams four chunks; the persisted offset mirrors the
    // server's chunk cache so observe() can skip everything already seen.
    expect(loadStreamOffset(window.localStorage, RUN_ID)).toBe(4);
  });

  it('resume() keeps counting from the persisted offset', async () => {
    const run = fakeRun();
    workflowMock.createRun.mockResolvedValue(run);
    const client = createMastraInterviewClient('http://localhost', window.localStorage);

    await collect(client.start(startInput).events);
    await collect(client.resume(RUN_ID, { answer: 'My answer.' }));

    expect(loadStreamOffset(window.localStorage, RUN_ID)).toBe(8);
  });

  it('observe() rejoins the run stream at the persisted offset and settles on the outcome', async () => {
    const run = fakeRun();
    workflowMock.createRun.mockResolvedValue(run);
    const client = createMastraInterviewClient('http://localhost', window.localStorage);
    await collect(client.start(startInput).events);

    const events = await collect(client.observe(RUN_ID));

    expect(run.observe).toHaveBeenCalledWith({ offset: 4 });
    expect(events).toEqual([
      { type: 'cue', label: 'Loading the next question…' },
      { type: 'question-start' },
      { type: 'question-delta', text: 'Full question?' },
      {
        type: 'suspended',
        suspend: { kind: 'question', question: 'Full question?', questionNumber: 1 },
      },
    ]);
  });

  it('observe() works cold, with no prior offset (a cleared store rejoins from the start)', async () => {
    const run = fakeRun();
    workflowMock.createRun.mockResolvedValue(run);
    const client = createMastraInterviewClient('http://localhost', window.localStorage);

    const events = await collect(client.observe(RUN_ID));

    expect(run.observe).toHaveBeenCalledWith({ offset: 0 });
    expect(events.at(-1)).toEqual({
      type: 'suspended',
      suspend: { kind: 'question', question: 'Full question?', questionNumber: 1 },
    });
  });

  it('observe() does not advance the persisted offset — replayed chunks are not new cache entries', async () => {
    const run = fakeRun();
    workflowMock.createRun.mockResolvedValue(run);
    const client = createMastraInterviewClient('http://localhost', window.localStorage);
    await collect(client.start(startInput).events);

    await collect(client.observe(RUN_ID));

    expect(loadStreamOffset(window.localStorage, RUN_ID)).toBe(4);
  });
});
