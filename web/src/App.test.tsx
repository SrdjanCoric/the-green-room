import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import type { PrepareInterviewResponse } from './lib/api';
import { initialInterviewState } from './lib/interviewMachine';
import { loadSession, saveSession } from './lib/sessionStore';
import type { InterviewClient, InterviewEvent, InterviewReport } from './lib/types';

const report: InterviewReport = {
  targetLevel: 'staff',
  role: 'Staff Engineer',
  company: 'Figma',
  coaching: {
    summary: 'Strong, concrete material.',
    answerAdvice: [{ question: 'Proudest work?', diagnosis: 'No number.', fix: 'Add a metric.' }],
    drills: [{ focus: 'Landing the result', exercise: 'Write the last line.' }],
    studyPlan: 'Quantify every story.',
  },
  transcript: [{ question: 'Proudest work?', answer: 'I led a migration.' }],
};

async function* startEvents(): AsyncGenerator<InterviewEvent> {
  yield { type: 'cue', label: 'Reading your CV' };
  yield { type: 'suspended', suspend: { kind: 'question', question: 'Proudest work?', questionNumber: 1 } };
}

async function* resumeEvents(): AsyncGenerator<InterviewEvent> {
  yield { type: 'cue', label: 'Weighing your answer…' };
  yield { type: 'completed', report };
}

async function* closingResume(): AsyncGenerator<InterviewEvent> {
  yield { type: 'cue', label: 'Weighing your answer…' };
  yield { type: 'closing-start' };
  yield { type: 'closing-delta', text: 'Thanks for walking me through the migration today.' };
  yield { type: 'completed', report };
}

async function* noEvents(): AsyncGenerator<InterviewEvent> {}

function mockClient(): InterviewClient {
  return {
    start: (input) => ({ runId: input.threadId, events: startEvents() }),
    resume: () => resumeEvents(),
    observe: () => noEvents(),
  };
}

const prepared: PrepareInterviewResponse = { cvPath: '/data/uploads/x.md', researchUrls: [] };

describe('App — full interview flow', () => {
  beforeEach(() => {
    window.location.hash = '';
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('runs setup → streamed question → answer → report against a mock client', async () => {
    const prepare = vi.fn(async () => prepared);
    render(<App client={mockClient()} prepare={prepare} storage={window.localStorage} />);

    // Setup → begin the audition.
    await userEvent.upload(screen.getByLabelText(/cv file/i), new File(['# CV'], 'me.md'));
    await userEvent.click(screen.getByRole('button', { name: /paste/i }));
    await userEvent.type(screen.getByLabelText(/posting text/i), 'Staff Engineer.');
    await userEvent.click(screen.getByRole('button', { name: /raise the curtain/i }));

    expect(prepare).toHaveBeenCalledOnce();

    // The streamed question arrives.
    expect(await screen.findByText('Proudest work?')).toBeInTheDocument();

    // Deliver the answer.
    await userEvent.type(screen.getByLabelText(/your answer/i), 'I led a migration.');
    await userEvent.click(screen.getByRole('button', { name: /deliver/i }));

    // The report renders.
    expect(await screen.findByText(/strong, concrete material/i)).toBeInTheDocument();
    expect(screen.getByText(/quantify every story/i)).toBeInTheDocument();

    // The finished run is recorded in the playbill.
    expect(screen.getByText('Staff Engineer')).toBeInTheDocument();
    expect(screen.getByText(/★ closed/i)).toBeInTheDocument();
  });

  it('surfaces the report once, without trapping later navigation', async () => {
    const prepare = vi.fn(async () => prepared);
    render(<App client={mockClient()} prepare={prepare} storage={window.localStorage} />);

    await userEvent.upload(screen.getByLabelText(/cv file/i), new File(['# CV'], 'me.md'));
    await userEvent.click(screen.getByRole('button', { name: /paste/i }));
    await userEvent.type(screen.getByLabelText(/posting text/i), 'Staff Engineer.');
    await userEvent.click(screen.getByRole('button', { name: /raise the curtain/i }));
    await userEvent.type(await screen.findByLabelText(/your answer/i), 'I led a migration.');
    await userEvent.click(screen.getByRole('button', { name: /deliver/i }));
    expect(await screen.findByText(/strong, concrete material/i)).toBeInTheDocument();

    // Leaving the finished report for a new audition must stick — the auto-surface
    // fires once per completed run, it does not enforce the report route forever.
    await userEvent.click(screen.getByRole('button', { name: /new audition/i }));
    expect(await screen.findByRole('button', { name: /raise the curtain/i })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText(/strong, concrete material/i)).not.toBeInTheDocument();
    expect(window.location.hash).toBe('#/setup');
  });

  it('shows a cached report when its route is reached by a plain hash change', async () => {
    // Back/forward and manual hash edits reach the report route without a playbill
    // click; the cache must still be consulted.
    window.localStorage.setItem('green-room:report:run-a', JSON.stringify(report));
    render(<App client={mockClient()} prepare={vi.fn(async () => prepared)} storage={window.localStorage} />);

    window.location.hash = '#/report/run-a';
    window.dispatchEvent(new Event('hashchange'));

    expect(await screen.findByText(/strong, concrete material/i)).toBeInTheDocument();
  });

  it('does not yank a candidate back who walks away mid-goodbye', async () => {
    const client: InterviewClient = {
      start: (input) => ({ runId: input.threadId, events: startEvents() }),
      resume: () => closingResume(),
      observe: () => noEvents(),
    };
    const prepare = vi.fn(async () => prepared);
    render(<App client={client} prepare={prepare} storage={window.localStorage} />);

    await userEvent.upload(screen.getByLabelText(/cv file/i), new File(['# CV'], 'me.md'));
    await userEvent.click(screen.getByRole('button', { name: /paste/i }));
    await userEvent.type(screen.getByLabelText(/posting text/i), 'Staff Engineer.');
    await userEvent.click(screen.getByRole('button', { name: /raise the curtain/i }));
    await userEvent.type(await screen.findByLabelText(/your answer/i), 'I led a migration.');
    await userEvent.click(screen.getByRole('button', { name: /deliver/i }));

    // The goodbye starts typing (the run has completed behind it) and the candidate
    // leaves for a new audition — their choice must stick, not be overridden by the
    // deferred report reveal.
    expect(await screen.findByText(/thanks for walking/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /new audition/i }));
    expect(await screen.findByRole('button', { name: /raise the curtain/i })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(screen.queryByText(/strong, concrete material/i)).not.toBeInTheDocument();
    expect(window.location.hash).toBe('#/setup');
  });

  it('counts a report the candidate opened themselves as surfaced', async () => {
    const client: InterviewClient = {
      start: (input) => ({ runId: input.threadId, events: startEvents() }),
      resume: () => closingResume(),
      observe: () => noEvents(),
    };
    const prepare = vi.fn(async () => prepared);
    render(<App client={client} prepare={prepare} storage={window.localStorage} />);

    await userEvent.upload(screen.getByLabelText(/cv file/i), new File(['# CV'], 'me.md'));
    await userEvent.click(screen.getByRole('button', { name: /paste/i }));
    await userEvent.type(screen.getByLabelText(/posting text/i), 'Staff Engineer.');
    await userEvent.click(screen.getByRole('button', { name: /raise the curtain/i }));
    await userEvent.type(await screen.findByLabelText(/your answer/i), 'I led a migration.');
    await userEvent.click(screen.getByRole('button', { name: /deliver/i }));

    // Mid-goodbye, the candidate opens their own finished run from the playbill.
    expect(await screen.findByText(/thanks for walking/i)).toBeInTheDocument();
    await userEvent.click(await screen.findByText(/★ closed/i));
    expect(await screen.findByText(/strong, concrete material/i)).toBeInTheDocument();

    // Leaving it afterwards must stick: that run already had its curtain call.
    await userEvent.click(screen.getByRole('button', { name: /new audition/i }));
    expect(await screen.findByRole('button', { name: /raise the curtain/i })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(window.location.hash).toBe('#/setup');
  });

  it('lets the goodbye finish typing before the report takes the stage', async () => {
    const client: InterviewClient = {
      start: (input) => ({ runId: input.threadId, events: startEvents() }),
      resume: () => closingResume(),
      observe: () => noEvents(),
    };
    const prepare = vi.fn(async () => prepared);
    render(<App client={client} prepare={prepare} storage={window.localStorage} />);

    await userEvent.upload(screen.getByLabelText(/cv file/i), new File(['# CV'], 'me.md'));
    await userEvent.click(screen.getByRole('button', { name: /paste/i }));
    await userEvent.type(screen.getByLabelText(/posting text/i), 'Staff Engineer.');
    await userEvent.click(screen.getByRole('button', { name: /raise the curtain/i }));

    await userEvent.type(await screen.findByLabelText(/your answer/i), 'I led a migration.');
    await userEvent.click(screen.getByRole('button', { name: /deliver/i }));

    // The goodbye starts typing; the run has already completed behind it, but the
    // report must wait for the line to land.
    expect(await screen.findByText(/thanks for walking/i)).toBeInTheDocument();
    expect(screen.queryByText(/strong, concrete material/i)).not.toBeInTheDocument();

    // Once the goodbye finishes, the notes take the stage.
    expect(await screen.findByText(/strong, concrete material/i)).toBeInTheDocument();
  });

  it('surfaces a failed turn with a retry that resumes the run with { retry: true }', async () => {
    async function* failingResume(): AsyncGenerator<InterviewEvent> {
      yield { type: 'suspended', suspend: { kind: 'failure', reason: 'The assessor call failed.' } };
    }
    const resume = vi.fn((_runId: string, resumeData: unknown) =>
      typeof resumeData === 'object' && resumeData !== null && 'retry' in resumeData
        ? resumeEvents()
        : failingResume(),
    );
    const client: InterviewClient = {
      start: (input) => ({ runId: input.threadId, events: startEvents() }),
      resume,
      observe: () => noEvents(),
    };
    const prepare = vi.fn(async () => prepared);
    render(<App client={client} prepare={prepare} storage={window.localStorage} />);

    await userEvent.upload(screen.getByLabelText(/cv file/i), new File(['# CV'], 'me.md'));
    await userEvent.click(screen.getByRole('button', { name: /paste/i }));
    await userEvent.type(screen.getByLabelText(/posting text/i), 'Staff Engineer.');
    await userEvent.click(screen.getByRole('button', { name: /raise the curtain/i }));

    // Answer the question; the turn faults and the run pauses instead of dying.
    await userEvent.type(await screen.findByLabelText(/your answer/i), 'I led a migration.');
    await userEvent.click(screen.getByRole('button', { name: /deliver/i }));
    expect(await screen.findByText(/the assessor call failed/i)).toBeInTheDocument();

    // The retry resumes the same run with the retry payload and reaches the report.
    await userEvent.click(screen.getByRole('button', { name: /retry the turn/i }));
    expect(await screen.findByText(/strong, concrete material/i)).toBeInTheDocument();

    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenNthCalledWith(1, expect.any(String), { answer: 'I led a migration.' });
    expect(resume).toHaveBeenNthCalledWith(2, expect.any(String), { retry: true });
    // The retry targets the same run the answer went to, not a fresh one.
    expect(resume.mock.calls[1]?.[0]).toBe(resume.mock.calls[0]?.[0]);
  });

  it('offers the paste fallback and does not start when a posting link fails to resolve', async () => {
    const prepare = vi.fn(async () => ({
      cvPath: '/data/uploads/x.md',
      researchUrls: [],
      postingFetchFailedUrl: 'https://jobs.example.com/dead',
    }));
    const client: InterviewClient = {
      start: vi.fn(() => {
        throw new Error('start must not be called after a failed posting fetch');
      }),
      resume: vi.fn(),
      observe: () => noEvents(),
    };
    render(<App client={client} prepare={prepare} storage={window.localStorage} />);

    await userEvent.upload(screen.getByLabelText(/cv file/i), new File(['# CV'], 'me.md'));
    await userEvent.type(
      screen.getByPlaceholderText(/jobs\.example\.com|https/i),
      'https://jobs.example.com/dead',
    );
    await userEvent.click(screen.getByRole('button', { name: /raise the curtain/i }));

    expect(await screen.findByText(/couldn't read the posting/i)).toBeInTheDocument();
    expect(client.start).not.toHaveBeenCalled();
  });
});

describe('App — durable reconnect', () => {
  beforeEach(() => {
    window.location.hash = '';
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  /** A run mid-interview in a previous page load: history entry, saved session. */
  function seedLiveRun(runId: string) {
    window.localStorage.setItem(
      'green-room:history',
      JSON.stringify([{ runId, startedAt: '2026-07-08T09:00:00Z', status: 'live' }]),
    );
    saveSession(window.localStorage, runId, {
      ...initialInterviewState,
      phase: 'awaitingAnswer',
      runId,
      transcript: [{ question: 'Proudest work?', answer: 'I led a migration.' }],
      currentQuestion: 'What did the migra',
      currentQuestionNumber: 2,
    });
  }

  async function* observedQuestion(): AsyncGenerator<InterviewEvent> {
    // The rejoined stream re-plays the in-flight segment from its start: the reply
    // opens over (question-start), then streams in full — never appended to the
    // snapshot's partial text.
    yield { type: 'question-start' };
    yield { type: 'question-delta', text: 'What did the migration teach you?' };
    yield {
      type: 'suspended',
      suspend: { kind: 'question', question: 'What did the migration teach you?', questionNumber: 2 },
    };
  }

  it('rejoins an in-flight run after a reload, then completes it without restarting', async () => {
    seedLiveRun('run-live');
    window.location.hash = '#/interview/run-live';
    const observe = vi.fn(() => observedQuestion());
    const resume = vi.fn(() => resumeEvents());
    const start = vi.fn(() => {
      throw new Error('a reload must rejoin the run, not start a new one');
    });
    render(
      <App client={{ start, resume, observe }} prepare={vi.fn(async () => prepared)} storage={window.localStorage} />,
    );

    // The in-flight question is rebuilt from the rejoined stream — replacing the
    // snapshot's partial text, not duplicating it.
    expect(await screen.findByText('What did the migration teach you?')).toBeInTheDocument();
    expect(screen.queryByText(/What did the migra$/)).not.toBeInTheDocument();
    expect(observe).toHaveBeenCalledExactlyOnceWith('run-live');
    expect(start).not.toHaveBeenCalled();

    // The rejoined run continues to completion over the normal resume path.
    await userEvent.type(screen.getByLabelText(/your answer/i), 'It taught me plenty.');
    await userEvent.click(screen.getByRole('button', { name: /deliver/i }));
    expect(await screen.findByText(/strong, concrete material/i)).toBeInTheDocument();
    expect(resume).toHaveBeenCalledExactlyOnceWith('run-live', { answer: 'It taught me plenty.' });

    // The finished run's session snapshot is gone; the report is cached instead.
    expect(loadSession(window.localStorage, 'run-live')).toBeNull();
  });

  it('reopens a live run from the playbill by rejoining its stream', async () => {
    seedLiveRun('run-live');
    const observe = vi.fn(() => observedQuestion());
    render(
      <App
        client={{ ...mockClient(), observe }}
        prepare={vi.fn(async () => prepared)}
        storage={window.localStorage}
      />,
    );

    await userEvent.click(screen.getByText(/now playing/i));

    expect(await screen.findByText('What did the migration teach you?')).toBeInTheDocument();
    expect(observe).toHaveBeenCalledExactlyOnceWith('run-live');
    expect(window.location.hash).toBe('#/interview/run-live');
  });

  it('persists the interview session as the run streams, so a reload has a snapshot', async () => {
    const prepare = vi.fn(async () => prepared);
    render(<App client={mockClient()} prepare={prepare} storage={window.localStorage} />);

    await userEvent.upload(screen.getByLabelText(/cv file/i), new File(['# CV'], 'me.md'));
    await userEvent.click(screen.getByRole('button', { name: /paste/i }));
    await userEvent.type(screen.getByLabelText(/posting text/i), 'Staff Engineer.');
    await userEvent.click(screen.getByRole('button', { name: /raise the curtain/i }));
    expect(await screen.findByText('Proudest work?')).toBeInTheDocument();

    const runId = window.location.hash.replace('#/interview/', '');
    expect(loadSession(window.localStorage, runId)).toMatchObject({
      phase: 'awaitingAnswer',
      currentQuestion: 'Proudest work?',
    });
  });
});
