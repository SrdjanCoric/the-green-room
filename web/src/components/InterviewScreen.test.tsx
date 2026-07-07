import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { initialInterviewState, type InterviewState } from '../lib/interviewMachine';
import { InterviewScreen } from './InterviewScreen';

function stateWith(overrides: Partial<InterviewState>): InterviewState {
  return { ...initialInterviewState, ...overrides };
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

    expect(screen.getByText('Proudest work?')).toBeInTheDocument();
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

  it('shows the streaming question without an answer box while it types in', () => {
    render(
      <InterviewScreen
        state={stateWith({ phase: 'streamingQuestion', currentQuestion: 'Walk me' })}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );

    expect(screen.getByText(/walk me/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/your answer/i)).not.toBeInTheDocument();
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
    await userEvent.type(screen.getByLabelText(/target level/i), 'staff');
    await userEvent.click(screen.getByRole('button', { name: /deliver/i }));

    expect(onSubmitLevel).toHaveBeenCalledWith('staff');
  });
});
