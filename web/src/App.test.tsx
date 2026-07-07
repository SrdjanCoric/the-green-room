import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import type { PrepareInterviewResponse } from './lib/api';
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

function mockClient(): InterviewClient {
  return {
    start: (input) => ({ runId: input.threadId, events: startEvents() }),
    resume: () => resumeEvents(),
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
