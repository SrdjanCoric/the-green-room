import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import { initialInterviewState, type InterviewState } from '../lib/interviewMachine';
import { InterviewScreen } from './InterviewScreen';

function stateWith(overrides: Partial<InterviewState>): InterviewState {
  return { ...initialInterviewState, ...overrides };
}

/**
 * The screen with the reveal loop its host provides in production: when the goodbye
 * finishes typing, `onClosingRevealed` flips `closingRevealed` in the state.
 */
function RevealHarness({ initial }: { initial: InterviewState }) {
  const [state, setState] = useState(initial);
  return (
    <InterviewScreen
      state={state}
      onSubmitAnswer={vi.fn()}
      onSubmitLevel={vi.fn()}
      onClosingRevealed={() => setState((current) => ({ ...current, closingRevealed: true }))}
    />
  );
}

describe('InterviewScreen', () => {
  it('renders answered turns from the transcript', () => {
    render(
      <InterviewScreen
        state={stateWith({
          phase: 'assessing',
          transcript: [{ question: 'Proudest work?', answer: 'The migration.' }],
          cue: 'Weighing your answer…',
        })}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );

    expect(screen.getByText('Proudest work?')).toBeInTheDocument();
    expect(screen.getByText(/the migration\./i)).toBeInTheDocument();
    expect(screen.getByText(/weighing your answer/i)).toBeInTheDocument();
  });

  it('shows a delivered answer to the interviewer and streams it back to the run', async () => {
    const onSubmitAnswer = vi.fn();
    render(
      <InterviewScreen
        state={stateWith({ phase: 'awaitingAnswer', currentQuestion: 'Proudest work?', currentQuestionNumber: 1 })}
        onSubmitAnswer={onSubmitAnswer}
        onSubmitLevel={vi.fn()}
      />,
    );

    expect(await screen.findByText('Proudest work?')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/your answer/i), 'I led a migration.');
    await userEvent.click(screen.getByRole('button', { name: /deliver/i }));

    expect(onSubmitAnswer).toHaveBeenCalledWith('I led a migration.');
  });

  it('does not deliver an empty answer', async () => {
    const onSubmitAnswer = vi.fn();
    render(
      <InterviewScreen
        state={stateWith({ phase: 'awaitingAnswer', currentQuestion: 'Q?' })}
        onSubmitAnswer={onSubmitAnswer}
        onSubmitLevel={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /deliver/i }));
    expect(onSubmitAnswer).not.toHaveBeenCalled();
  });

  it('shows the streaming question without an answer box while it types in', async () => {
    render(
      <InterviewScreen
        state={stateWith({ phase: 'streamingQuestion', currentQuestion: 'Walk me' })}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );

    expect(await screen.findByText(/walk me/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/your answer/i)).not.toBeInTheDocument();
  });

  it('types the question out over time instead of stamping it', async () => {
    render(
      <InterviewScreen
        state={stateWith({
          phase: 'streamingQuestion',
          currentQuestion: 'Walk me through the hardest bug you fixed.',
        })}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );

    // The tail of the question is not on screen at first; it types in.
    expect(screen.queryByText(/hardest bug you fixed/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/hardest bug you fixed/i)).toBeInTheDocument();
  });

  it('types the interviewer’s goodbye out as their own line after the last answer', async () => {
    render(
      <InterviewScreen
        state={stateWith({
          phase: 'closing',
          transcript: [{ question: 'Proudest work?', answer: 'The migration.' }],
          closingMessage: 'Thanks for walking me through the migration work today.',
        })}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );

    // It types in over time like a question, attributed to the interviewer.
    expect(screen.queryByText(/migration work today/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/migration work today/i)).toBeInTheDocument();
    expect(screen.getAllByText(/the interviewer/i).length).toBeGreaterThan(0);
  });

  it('holds the grading back until the goodbye has fully typed out', async () => {
    render(
      <RevealHarness
        initial={stateWith({
          phase: 'grading',
          transcript: [{ question: 'Proudest work?', answer: 'The migration.' }],
          closingMessage: 'Thanks for walking me through the migration work today.',
          reportPreview: 'You perform like someone who has done the work',
          cue: 'Grading your answers…',
        })}
      />,
    );

    // While the goodbye is still typing, neither the grading cue nor the report
    // preview is on stage.
    expect(screen.queryByText(/grading your answers/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/you perform like someone/i)).not.toBeInTheDocument();

    // Once the goodbye finishes typing, grading takes the stage.
    expect(await screen.findByText(/migration work today/i)).toBeInTheDocument();
    expect(await screen.findByText(/grading your answers/i)).toBeInTheDocument();
    expect(await screen.findByText(/you perform like someone/i)).toBeInTheDocument();
  });

  it('shows an already-delivered goodbye whole on a remount, grading still on stage', () => {
    // Navigating away and back during grading remounts the screen; a goodbye the
    // machine has already marked revealed must not retype or re-hide the grading.
    render(
      <InterviewScreen
        state={stateWith({
          phase: 'grading',
          transcript: [{ question: 'Proudest work?', answer: 'The migration.' }],
          closingMessage: 'Thanks for walking me through the migration work today.',
          closingRevealed: true,
          reportPreview: 'You perform like someone who has done the work',
          cue: 'Grading your answers…',
        })}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );

    // All of it is on stage immediately — no typewriter delay, no hidden grading.
    expect(screen.getByText(/migration work today/i)).toBeInTheDocument();
    expect(screen.getByText(/grading your answers/i)).toBeInTheDocument();
    expect(screen.getByText(/you perform like someone/i)).toBeInTheDocument();
  });

  it('streams the director-notes preview while the report is being written', () => {
    render(
      <InterviewScreen
        state={stateWith({
          phase: 'grading',
          reportPreview: 'You perform like someone who has done the work',
          cue: "Writing the director's notes…",
        })}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );

    expect(screen.getByText(/you perform like someone who has done the work/i)).toBeInTheDocument();
  });

  it('follows the conversation down the page as new content lands', async () => {
    const { rerender } = render(
      <InterviewScreen
        state={stateWith({ phase: 'streamingQuestion', currentQuestion: 'Walk' })}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );
    await screen.findByText(/walk/i);
    vi.mocked(window.scrollTo).mockClear();

    rerender(
      <InterviewScreen
        state={stateWith({
          phase: 'streamingQuestion',
          currentQuestion: 'Walk me through the hardest bug you fixed.',
        })}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );

    await screen.findByText(/hardest bug you fixed/i);
    expect(window.scrollTo).toHaveBeenCalled();
  });

  it('asks for the target level when the run suspends for it', async () => {
    const onSubmitLevel = vi.fn();
    render(
      <InterviewScreen
        state={stateWith({ phase: 'awaitingLevel', levelPrompt: 'What level are you targeting?' })}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={onSubmitLevel}
      />,
    );

    expect(screen.getByText(/what level are you targeting/i)).toBeInTheDocument();

    // Deliver confirms the clicked selection, and is inert until one is made.
    expect(screen.getByRole('button', { name: /deliver/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /^staff$/i }));
    await userEvent.click(screen.getByRole('button', { name: /deliver/i }));

    expect(onSubmitLevel).toHaveBeenCalledWith('staff');
  });
});
