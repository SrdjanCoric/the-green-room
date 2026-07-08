import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StreamChunk } from './chunkInterpreter';
import { createMastraInterviewClient } from './mastraInterviewClient';
import { loadRunMeta } from './sessionStore';
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

/** A stream that delivers some chunks and then dies mid-segment (the disconnect). */
function dyingStream(chunks: StreamChunk[]): ReadableStream<unknown> {
  let delivered = 0;
  return new ReadableStream({
    // Pull-based so the chunks are actually read before the failure lands —
    // erroring up front would discard the queue and deliver nothing.
    pull(controller) {
      if (delivered < chunks.length) controller.enqueue(chunks[delivered++]);
      else controller.error(new Error('connection dropped'));
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

async function collectUntilError(iter: AsyncIterable<InterviewEvent>): Promise<InterviewEvent[]> {
  const out: InterviewEvent[] = [];
  try {
    for await (const event of iter) out.push(event);
  } catch {
    // The disconnect surfaces here; the caller inspects what arrived before it.
  }
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
    expect(loadRunMeta(window.localStorage, RUN_ID).offset).toBe(4);
  });

  it('resume() keeps counting from the persisted offset', async () => {
    const run = fakeRun();
    workflowMock.createRun.mockResolvedValue(run);
    const client = createMastraInterviewClient('http://localhost', window.localStorage);

    await collect(client.start(startInput).events);
    await collect(client.resume(RUN_ID, { answer: 'My answer.' }));

    expect(loadRunMeta(window.localStorage, RUN_ID).offset).toBe(8);
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

    expect(loadRunMeta(window.localStorage, RUN_ID).offset).toBe(4);
  });

  it('persists chunks seen before a mid-segment disconnect, and observe completes the content once', async () => {
    const segment = questionSegment('Full question?');
    const run = fakeRun({
      // The connection dies two chunks into the segment.
      stream: vi.fn(async () => dyingStream(segment.slice(0, 2))),
    });
    workflowMock.createRun.mockResolvedValue(run);
    const client = createMastraInterviewClient('http://localhost', window.localStorage);

    await collectUntilError(client.start(startInput).events);
    expect(loadRunMeta(window.localStorage, RUN_ID).offset).toBe(2);

    // A fresh page (new client, same storage) rejoins; the server replays the
    // segment from its start and the interpreted events rebuild it exactly once.
    const reloaded = createMastraInterviewClient('http://localhost', window.localStorage);
    const events = await collect(reloaded.observe(RUN_ID));

    expect(run.observe).toHaveBeenCalledWith({ offset: 2 });
    expect(events.filter((e) => e.type === 'question-delta')).toEqual([
      { type: 'question-delta', text: 'Full question?' },
    ]);
    expect(events.at(-1)).toEqual({
      type: 'suspended',
      suspend: { kind: 'question', question: 'Full question?', questionNumber: 1 },
    });
  });

  it('restores the run’s model ensemble from storage after a reload', async () => {
    const run = fakeRun();
    workflowMock.createRun.mockResolvedValue(run);
    const client = createMastraInterviewClient('http://localhost', window.localStorage);
    await collect(
      client.start({
        ...startInput,
        ensemble: { provider: 'openai', fastModel: 'gpt-fast', smartModel: 'gpt-smart' },
      }).events,
    );

    // A fresh page: the in-memory run map is gone, only storage survives.
    const reloaded = createMastraInterviewClient('http://localhost', window.localStorage);
    await collect(reloaded.resume(RUN_ID, { answer: 'My answer.' }));

    expect(run.resumeStream).toHaveBeenCalledWith({
      resumeData: { answer: 'My answer.' },
      requestContext: { 'model.fast': 'openai/gpt-fast', 'model.smart': 'openai/gpt-smart' },
    });
  });

  it('observe() after a mid-turn reload waits out the pre-resume state instead of re-presenting it', async () => {
    const preResume = {
      status: 'suspended',
      updatedAt: new Date('2026-07-08T10:00:00Z'),
      suspendPayload: { kind: 'question', question: 'Question one?', questionNumber: 1 },
    };
    const settled = {
      status: 'suspended',
      updatedAt: new Date('2026-07-08T10:05:00Z'),
      suspendPayload: { kind: 'question', question: 'Question two?', questionNumber: 2 },
    };
    workflowMock.runById.mockResolvedValue(preResume);
    const run = fakeRun({
      // The resume request goes out, then the page dies before anything arrives.
      resumeStream: vi.fn(async () => dyingStream([])),
    });
    workflowMock.createRun.mockResolvedValue(run);

    const client = createMastraInterviewClient('http://localhost', window.localStorage);
    await collect(client.start(startInput).events);
    await collectUntilError(client.resume(RUN_ID, { answer: 'A1.' }));
    // The floor is armed: anything at or before the pre-resume write is not an outcome.
    expect(loadRunMeta(window.localStorage, RUN_ID).staleAsOf).toBe(preResume.updatedAt.getTime());

    // After the reload, the run's snapshot still shows the answered question for a
    // while; observe must wait for the turn's real result, not settle on the past.
    let reads = 0;
    workflowMock.runById.mockImplementation(async () => (++reads < 2 ? preResume : settled));
    const reloaded = createMastraInterviewClient('http://localhost', window.localStorage);
    const events = await collect(reloaded.observe(RUN_ID));

    expect(events.at(-1)).toEqual({
      type: 'suspended',
      suspend: { kind: 'question', question: 'Question two?', questionNumber: 2 },
    });
    // The floor disarms once the turn settles, so a later reload while genuinely
    // suspended does not reject the legitimate state.
    expect(loadRunMeta(window.localStorage, RUN_ID).staleAsOf).toBeUndefined();
  }, 20000);
});
