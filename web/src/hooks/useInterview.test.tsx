import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useInterview } from './useInterview';
import type { InterviewClient, InterviewEvent, StartInterviewInput } from '../lib/types';

const startInput: StartInterviewInput = {
  cvPath: '/tmp/cv.pdf',
  researchUrls: [],
  candidate: 'cand-1',
  threadId: 'run-1',
};

const question = (questionNumber: number): InterviewEvent => ({
  type: 'suspended',
  suspend: { kind: 'question', question: `Question ${questionNumber}?`, questionNumber },
});

/** An async iterable that yields the given events once, then completes. */
function stream(events: InterviewEvent[]): AsyncIterable<InterviewEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

describe('useInterview double-submit guard', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('fires exactly one resume when the answer is submitted twice in a row', async () => {
    const resume = vi.fn(() => stream([question(2)]));
    const client: InterviewClient = {
      start: vi.fn(() => ({ runId: 'run-1', events: stream([question(1)]) })),
      resume,
      observe: vi.fn(() => stream([])),
    };

    const { result } = renderHook(() => useInterview(client));

    await act(async () => {
      result.current.start(startInput);
    });
    await waitFor(() => expect(result.current.state.phase).toBe('awaitingAnswer'));

    // Two clicks land before the first submit re-renders the button away.
    await act(async () => {
      result.current.submitAnswer('My answer.');
      result.current.submitAnswer('My answer, again.');
    });

    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith('run-1', { answer: 'My answer.' });
  });

  it('closes the active stream iterator when the component unmounts', async () => {
    let returnCalled = false;
    // A stream that never settles: it models a live run in flight at unmount time.
    const openStream: AsyncIterable<InterviewEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<InterviewEvent>>(() => undefined),
          return: () => {
            returnCalled = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
    const client: InterviewClient = {
      start: vi.fn(() => ({ runId: 'run-1', events: openStream })),
      resume: vi.fn(() => stream([])),
      observe: vi.fn(() => stream([])),
    };

    const { result, unmount } = renderHook(() => useInterview(client));
    await act(async () => {
      result.current.start(startInput);
    });

    unmount();

    expect(returnCalled).toBe(true);
  });

  it('fires exactly one resume when the level is submitted twice in a row', async () => {
    const resume = vi.fn(() => stream([question(1)]));
    const client: InterviewClient = {
      start: vi.fn(() => ({
        runId: 'run-1',
        events: stream([{ type: 'suspended', suspend: { kind: 'level', prompt: 'What level?' } }]),
      })),
      resume,
      observe: vi.fn(() => stream([])),
    };

    const { result } = renderHook(() => useInterview(client));

    await act(async () => {
      result.current.start(startInput);
    });
    await waitFor(() => expect(result.current.state.phase).toBe('awaitingLevel'));

    await act(async () => {
      result.current.submitLevel('senior');
      result.current.submitLevel('staff');
    });

    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith('run-1', { level: 'senior' });
  });
});
