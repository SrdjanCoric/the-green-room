import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StrictMode, useState } from 'react';

import { initialInterviewState, type InterviewState } from '../lib/interviewMachine';
import { QuestionSpeechController } from '../lib/questionSpeechController';
import type { SpeakQuestionOptions, SpeechPlayer } from '../lib/speechPlayer';
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

  it('disables the Deliver button the moment an answer is delivered, so a double-click sends once', async () => {
    const onSubmitAnswer = vi.fn();
    render(
      <InterviewScreen
        state={stateWith({ phase: 'awaitingAnswer', currentQuestion: 'Proudest work?', currentQuestionNumber: 1 })}
        onSubmitAnswer={onSubmitAnswer}
        onSubmitLevel={vi.fn()}
      />,
    );

    await userEvent.type(screen.getByLabelText(/your answer/i), 'I led a migration.');
    const deliver = screen.getByRole('button', { name: /deliver/i });
    await userEvent.dblClick(deliver);

    expect(onSubmitAnswer).toHaveBeenCalledTimes(1);
    expect(deliver).toBeDisabled();
  });

  it('disables the level Deliver button once a level is delivered', async () => {
    const onSubmitLevel = vi.fn();
    render(
      <InterviewScreen
        state={stateWith({ phase: 'awaitingLevel', levelPrompt: 'What level?' })}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={onSubmitLevel}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^staff$/i }));
    const deliver = screen.getByRole('button', { name: /deliver/i });
    await userEvent.dblClick(deliver);

    expect(onSubmitLevel).toHaveBeenCalledTimes(1);
    expect(deliver).toBeDisabled();
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

  it('hides streamed deltas in voice mode and gates answering on authoritative playback', async () => {
    let finishPlayback: (() => void) | undefined;
    const onProgress: ((prefix: string) => void)[] = [];
    const speak = vi.fn(
      ({ onProgress: progress }: SpeakQuestionOptions) =>
        new Promise<void>((resolve) => {
          onProgress.push(progress);
          finishPlayback = resolve;
        }),
    );
    const player: SpeechPlayer = { speak };
    const questionSpeech = new QuestionSpeechController(player);
    const { rerender } = render(
      <InterviewScreen
        state={stateWith({ phase: 'streamingQuestion', runId: 'run-1', currentQuestion: 'Partial' })}
        voiceEnabled
        questionSpeech={questionSpeech}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );

    expect(screen.queryByText('Partial')).not.toBeInTheDocument();
    expect(screen.getByText(/preparing the next question/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/your answer/i)).not.toBeInTheDocument();

    rerender(
      <InterviewScreen
        state={stateWith({
          phase: 'awaitingAnswer',
          runId: 'run-1',
          currentQuestion: 'Authoritative question?',
          currentQuestionNumber: 1,
        })}
        voiceEnabled
        questionSpeech={questionSpeech}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );
    expect(speak).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText(/your answer/i)).not.toBeInTheDocument();

    act(() => onProgress[0]?.('Authoritative'));
    expect(screen.getByText('Authoritative')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('');

    await act(async () => finishPlayback?.());
    expect(screen.getAllByText('Authoritative question?')).toHaveLength(2);
    expect(screen.getByLabelText(/your answer/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Authoritative question?');
  });

  it('cancels stale playback and speaks only an authoritative replacement', async () => {
    const signals: AbortSignal[] = [];
    let finishReplacement: (() => void) | undefined;
    const speak = vi.fn(
      ({ signal }: SpeakQuestionOptions) =>
        new Promise<void>((resolve, reject) => {
          signals.push(signal);
          if (signals.length === 2) finishReplacement = resolve;
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('replaced', 'AbortError')),
            { once: true },
          );
        }),
    );
    const questionSpeech = new QuestionSpeechController({ speak });
    const { rerender } = render(
      <InterviewScreen
        state={stateWith({
          phase: 'awaitingAnswer',
          runId: 'run-1',
          currentQuestion: 'First attempt?',
          currentQuestionNumber: 2,
        })}
        voiceEnabled
        questionSpeech={questionSpeech}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );
    await vi.waitFor(() => expect(speak).toHaveBeenCalledOnce());

    rerender(
      <InterviewScreen
        state={stateWith({
          phase: 'awaitingAnswer',
          runId: 'run-1',
          currentQuestion: 'Replacement question?',
          currentQuestionNumber: 2,
        })}
        voiceEnabled
        questionSpeech={questionSpeech}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );

    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(screen.queryByLabelText(/your answer/i)).not.toBeInTheDocument();
    await act(async () => finishReplacement?.());
    expect(screen.getAllByText('Replacement question?')).toHaveLength(2);
    expect(screen.getByLabelText(/your answer/i)).toBeInTheDocument();
  });

  it('falls back to the full typed question when spoken delivery fails', async () => {
    const player: SpeechPlayer = {
      speak: vi.fn(async () => Promise.reject(new Error('decode failed'))),
    };
    render(
      <InterviewScreen
        state={stateWith({
          phase: 'awaitingAnswer',
          runId: 'run-1',
          currentQuestion: 'What did you learn?',
          currentQuestionNumber: 2,
        })}
        voiceEnabled
        questionSpeech={new QuestionSpeechController(player)}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );

    expect(await screen.findByLabelText(/your answer/i)).toBeInTheDocument();
    expect(screen.getAllByText('What did you learn?')).toHaveLength(2);
  });

  it('shows the full spoken question when playback starts under reduced motion', async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    let finishPlayback: (() => void) | undefined;
    const speak = vi.fn(
      ({ onPlaybackStart }: SpeakQuestionOptions) =>
        new Promise<void>((resolve) => {
          onPlaybackStart?.();
          finishPlayback = resolve;
        }),
    );
    const player: SpeechPlayer = { speak };
    try {
      render(
        <InterviewScreen
          state={stateWith({
            phase: 'awaitingAnswer',
            runId: 'run-1',
            currentQuestion: 'A reduced-motion question?',
            currentQuestionNumber: 2,
          })}
          voiceEnabled
          questionSpeech={new QuestionSpeechController(player)}
          onSubmitAnswer={vi.fn()}
          onSubmitLevel={vi.fn()}
        />,
      );

      expect(await screen.findByText('A reduced-motion question?')).toBeInTheDocument();
      expect(screen.queryByLabelText(/your answer/i)).not.toBeInTheDocument();
      await act(async () => finishPlayback?.());
      expect(screen.getByLabelText(/your answer/i)).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });

  it('shows a reconnected question in full without replaying it', () => {
    const speak = vi.fn(async () => undefined);
    const player: SpeechPlayer = { speak };
    render(
      <InterviewScreen
        state={stateWith({
          phase: 'awaitingAnswer',
          runId: 'run-1',
          currentQuestion: 'Current saved question?',
          currentQuestionNumber: 3,
          suppressQuestionSpeech: true,
        })}
        voiceEnabled
        questionSpeech={new QuestionSpeechController(player)}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/your answer/i)).toBeInTheDocument();
    expect(screen.getAllByText('Current saved question?')).toHaveLength(2);
    expect(speak).not.toHaveBeenCalled();
  });

  it('keeps the level prompt silent in voice mode', () => {
    const speak = vi.fn(async () => undefined);
    const player: SpeechPlayer = { speak };
    render(
      <InterviewScreen
        state={stateWith({ phase: 'awaitingLevel', runId: 'run-1', levelPrompt: 'What level?' })}
        voiceEnabled
        questionSpeech={new QuestionSpeechController(player)}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );

    expect(screen.getByText('What level?')).toBeInTheDocument();
    expect(speak).not.toHaveBeenCalled();
  });

  it('holds the report preview until the settled closing finishes spoken delivery', async () => {
    let finishPlayback: (() => void) | undefined;
    let progress: ((prefix: string) => void) | undefined;
    const speak = vi.fn(
      ({ onProgress }: SpeakQuestionOptions) =>
        new Promise<void>((resolve) => {
          progress = onProgress;
          finishPlayback = resolve;
        }),
    );
    const controller = new QuestionSpeechController({ speak });

    function SpokenClosingHarness() {
      const [state, setState] = useState(
        stateWith({
          phase: 'grading',
          runId: 'run-1',
          closingMessage: 'Thanks for walking me through the migration today.',
          reportPreview: 'You perform like someone who has done the work',
        }),
      );
      return (
        <InterviewScreen
          state={state}
          voiceEnabled
          questionSpeech={controller}
          onSubmitAnswer={vi.fn()}
          onSubmitLevel={vi.fn()}
          onClosingRevealed={() =>
            setState((current) => ({ ...current, closingRevealed: true }))
          }
        />
      );
    }

    render(
      <StrictMode>
        <SpokenClosingHarness />
      </StrictMode>,
    );

    await vi.waitFor(() => expect(speak).toHaveBeenCalledOnce());
    expect(screen.queryByText(/you perform like someone/i)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('');
    act(() => progress?.('Thanks for walking'));
    expect(screen.getByText('Thanks for walking')).toBeInTheDocument();

    await act(async () => finishPlayback?.());
    expect(screen.getAllByText(/migration today/i)).toHaveLength(2);
    expect(screen.getByText(/you perform like someone/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Thanks for walking me through the migration today.',
    );
  });

  it('reveals the full closing and releases the report when spoken delivery fails', async () => {
    const controller = new QuestionSpeechController({
      speak: vi.fn(async () => Promise.reject(new Error('decode failed'))),
    });

    function FailedClosingHarness() {
      const [state, setState] = useState(
        stateWith({
          phase: 'grading',
          runId: 'run-1',
          closingMessage: 'Thanks for walking me through that today.',
          reportPreview: 'Your report is ready.',
        }),
      );
      return (
        <InterviewScreen
          state={state}
          voiceEnabled
          questionSpeech={controller}
          onSubmitAnswer={vi.fn()}
          onSubmitLevel={vi.fn()}
          onClosingRevealed={() =>
            setState((current) => ({ ...current, closingRevealed: true }))
          }
        />
      );
    }

    render(<FailedClosingHarness />);

    expect(await screen.findByText(/your report is ready/i)).toBeInTheDocument();
    expect(screen.getAllByText(/thanks for walking me through that today/i)).toHaveLength(2);
  });

  it('shows the full spoken closing at playback start under reduced motion but keeps the gate', async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    let finishPlayback: (() => void) | undefined;
    const speak = vi.fn(
      ({ onPlaybackStart }: SpeakQuestionOptions) =>
        new Promise<void>((resolve) => {
          onPlaybackStart?.();
          finishPlayback = resolve;
        }),
    );

    function ReducedMotionClosingHarness() {
      const [state, setState] = useState(
        stateWith({
          phase: 'grading',
          runId: 'run-1',
          closingMessage: 'Thanks for walking me through that today.',
          reportPreview: 'Your report is ready.',
        }),
      );
      return (
        <InterviewScreen
          state={state}
          voiceEnabled
          questionSpeech={new QuestionSpeechController({ speak })}
          onSubmitAnswer={vi.fn()}
          onSubmitLevel={vi.fn()}
          onClosingRevealed={() =>
            setState((current) => ({ ...current, closingRevealed: true }))
          }
        />
      );
    }

    try {
      render(<ReducedMotionClosingHarness />);
      expect(await screen.findByText(/thanks for walking me through that today/i)).toBeInTheDocument();
      expect(screen.queryByText(/your report is ready/i)).not.toBeInTheDocument();
      await act(async () => finishPlayback?.());
      expect(screen.getByText(/your report is ready/i)).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });

  it('aborts spoken closing playback when the interview screen unmounts', async () => {
    let signal: AbortSignal | undefined;
    const speak = vi.fn(
      ({ signal: activeSignal }: SpeakQuestionOptions) =>
        new Promise<void>((_resolve, reject) => {
          signal = activeSignal;
          activeSignal.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true },
          );
        }),
    );
    const { unmount } = render(
      <InterviewScreen
        state={stateWith({
          phase: 'grading',
          runId: 'run-1',
          closingMessage: 'Thanks for today.',
        })}
        voiceEnabled
        questionSpeech={new QuestionSpeechController({ speak })}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );
    await vi.waitFor(() => expect(speak).toHaveBeenCalledOnce());

    unmount();
    await act(async () => Promise.resolve());

    expect(signal?.aborted).toBe(true);
  });

  it('shows a reconnected closing whole and releases the report without replaying it', async () => {
    const speak = vi.fn(async () => undefined);

    function ReconnectedClosingHarness() {
      const [state, setState] = useState(
        stateWith({
          phase: 'grading',
          runId: 'run-1',
          closingMessage: 'Thanks for walking me through that today.',
          suppressClosingSpeech: true,
          reportPreview: 'Your report is ready.',
        }),
      );
      return (
        <InterviewScreen
          state={state}
          voiceEnabled
          questionSpeech={new QuestionSpeechController({ speak })}
          onSubmitAnswer={vi.fn()}
          onSubmitLevel={vi.fn()}
          onClosingRevealed={() =>
            setState((current) => ({ ...current, closingRevealed: true }))
          }
        />
      );
    }

    render(<ReconnectedClosingHarness />);

    expect(await screen.findByText(/your report is ready/i)).toBeInTheDocument();
    expect(screen.getAllByText(/thanks for walking me through that today/i)).toHaveLength(2);
    expect(speak).not.toHaveBeenCalled();
  });

  it('waits for the closing boundary and ignores report deltas as replay triggers', async () => {
    const speak = vi.fn(
      ({ signal }: SpeakQuestionOptions) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true },
          );
        }),
    );
    const controller = new QuestionSpeechController({ speak });
    const props = {
      voiceEnabled: true,
      questionSpeech: controller,
      onSubmitAnswer: vi.fn(),
      onSubmitLevel: vi.fn(),
    };
    const { rerender } = render(
      <InterviewScreen
        {...props}
        state={stateWith({
          phase: 'closing',
          runId: 'run-1',
          closingMessage: 'Thanks for today.',
        })}
      />,
    );

    expect(speak).not.toHaveBeenCalled();
    rerender(
      <InterviewScreen
        {...props}
        state={stateWith({
          phase: 'grading',
          runId: 'run-1',
          closingMessage: 'Thanks for today.',
          reportPreview: 'First report delta',
        })}
      />,
    );
    await vi.waitFor(() => expect(speak).toHaveBeenCalledOnce());

    rerender(
      <InterviewScreen
        {...props}
        state={stateWith({
          phase: 'grading',
          runId: 'run-1',
          closingMessage: 'Thanks for today.',
          reportPreview: 'First report delta, then another',
        })}
      />,
    );
    expect(speak).toHaveBeenCalledOnce();
    expect(screen.queryByText(/first report delta/i)).not.toBeInTheDocument();
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
    expect(screen.getAllByText(/migration work today/i)).toHaveLength(2);
    expect(screen.getByText(/grading your answers/i)).toBeInTheDocument();
    expect(screen.getByText(/you perform like someone/i)).toBeInTheDocument();
  });

  it('streams the director-notes preview while the report is being written', () => {
    render(
      <InterviewScreen
        state={stateWith({
          phase: 'grading',
          reportPreview: 'You perform like someone who has done the work',
          cue: "Writing the coaching report…",
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

  it('announces the settled question to assistive tech and moves focus to the heading', () => {
    render(
      <InterviewScreen
        state={stateWith({ phase: 'awaitingAnswer', currentQuestion: 'Proudest work?', currentQuestionNumber: 1 })}
        onSubmitAnswer={vi.fn()}
        onSubmitLevel={vi.fn()}
      />,
    );

    // A live region carries the settled question for screen readers.
    expect(screen.getByRole('status')).toHaveTextContent('Proudest work?');
    // Focus lands on the new scene's heading after the transition.
    expect(screen.getByRole('heading', { name: /under the lights/i })).toHaveFocus();
  });

  it('shows the question whole at once when the user prefers reduced motion', () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    try {
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

      // No typewriter reveal: the tail is on screen immediately, not after a delay.
      expect(screen.getByText(/hardest bug you fixed/i)).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
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
