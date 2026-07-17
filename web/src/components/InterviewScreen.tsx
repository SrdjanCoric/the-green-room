import { useEffect, useRef, useState } from 'react';

import { useFocusOnMount } from '../hooks/useFocusOnMount';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { useStickToBottom } from '../hooks/useStickToBottom';
import type { InterviewState } from '../lib/interviewMachine';
import type { QuestionSpeechController } from '../lib/questionSpeechController';

export interface InterviewScreenProps {
  state: InterviewState;
  onSubmitAnswer: (answer: string) => void;
  onSubmitLevel: (level: string) => void;
  /** Reports that the goodbye's active delivery finished (drives the closing gate). */
  onClosingRevealed?: () => void;
  /** Whether this run should deliver authoritative questions with timed speech. */
  voiceEnabled?: boolean;
  /** Run-scoped controller that deduplicates and cancels browser utterances. */
  questionSpeech?: QuestionSpeechController;
}

/**
 * The interview "scene": the streamed script of questions and answers, a between-turns
 * cue line while the run works, and the cue card the candidate delivers their line
 * into. When the run suspends for the target level, that turn asks for it instead.
 */
export function InterviewScreen({
  state,
  onSubmitAnswer,
  onSubmitLevel,
  onClosingRevealed,
  voiceEnabled = false,
  questionSpeech,
}: InterviewScreenProps) {
  const streaming = state.phase === 'streamingQuestion';
  const awaitingAnswer = state.phase === 'awaitingAnswer';
  const awaitingLevel = state.phase === 'awaitingLevel';
  const grading = state.phase === 'grading';
  const showTypedQuestion = !voiceEnabled && (streaming || awaitingAnswer);
  const reducedMotion = usePrefersReducedMotion();
  const voiceQuestionId =
    voiceEnabled && awaitingAnswer && state.runId && state.currentQuestion
      ? `${state.runId}:${state.currentQuestionNumber}:${state.currentQuestion}`
      : null;
  const speechEligible =
    Boolean(voiceQuestionId) && !state.suppressQuestionSpeech && Boolean(questionSpeech);
  const voiceDelivery = useTimedSpeechDelivery({
    id: speechEligible ? voiceQuestionId : null,
    text: state.currentQuestion,
    controller: questionSpeech,
    reducedMotion,
  });
  const voiceSettled =
    voiceEnabled && awaitingAnswer && (!speechEligible || voiceDelivery.settled);
  const visibleVoiceQuestion =
    voiceSettled && !speechEligible ? state.currentQuestion : voiceDelivery.visibleText;
  const answerAvailable = awaitingAnswer && (!voiceEnabled || voiceSettled);

  // The first post-closing phase is the authoritative boundary: the closing step has
  // finished writing, even if grading/report deltas are already arriving behind it.
  const closingSettled =
    Boolean(state.closingMessage) && (state.phase === 'grading' || state.phase === 'report');
  const closingSpeechId =
    voiceEnabled && closingSettled && state.runId && !state.closingRevealed
      ? `${state.runId}:closing`
      : null;
  const closingSpeechEligible =
    Boolean(closingSpeechId) && !state.suppressClosingSpeech && Boolean(questionSpeech);
  const closingDelivery = useTimedSpeechDelivery({
    id: closingSpeechEligible ? closingSpeechId : null,
    text: state.closingMessage,
    controller: questionSpeech,
    reducedMotion,
    onSettled: onClosingRevealed,
  });
  const onClosingRevealedRef = useRef(onClosingRevealed);
  useEffect(() => {
    onClosingRevealedRef.current = onClosingRevealed;
  }, [onClosingRevealed]);
  useEffect(() => {
    if (closingSpeechId && !state.closingRevealed && !closingSpeechEligible) {
      onClosingRevealedRef.current?.();
    }
  }, [closingSpeechEligible, closingSpeechId, state.closingRevealed]);

  const visibleVoiceClosing =
    closingSettled && !closingSpeechEligible
      ? state.closingMessage
      : closingDelivery.visibleText;
  const closingVisuallySettled =
    state.closingRevealed || (closingSettled && !closingSpeechEligible);

  // Grading holds off stage until the goodbye has finished its active delivery mode.
  // The fact lives in the machine so remounting cannot re-hide a delivered closing.
  const closingRevealed = state.closingMessage.length === 0 || state.closingRevealed;

  // Follow the scene down the page: typed reveals and the streamed report preview
  // track instantly (straight from the tick callbacks — no re-render per tick); a new
  // turn (an answered question, a fresh cue card) glides.
  const follow = useStickToBottom({ beatTick: `${state.transcript.length}:${state.phase}` });
  useEffect(() => {
    if (state.reportPreview) follow('instant');
  }, [state.reportPreview, follow]);

  const onClosingShown = (shown: number) => {
    follow('instant');
    if (!state.closingRevealed && state.closingMessage && shown >= state.closingMessage.length) {
      onClosingRevealed?.();
    }
  };

  const heading = useFocusOnMount<HTMLHeadingElement>();

  return (
    <>
      {/*
        The settled question, announced once. The typewriter above is aria-hidden so
        assistive tech never reads it tick by tick; this live region carries the full
        question the moment it lands (on `awaitingAnswer`), and nothing before.
      */}
      <div className="sr-only" role="status">
        {answerAvailable
          ? state.currentQuestion
          : state.closingRevealed
            ? state.closingMessage
            : ''}
      </div>

      <div className="scene-meta">{sceneMeta(state)}</div>
      <h1
        ref={heading}
        tabIndex={-1}
        className="title-xl"
        style={{ fontSize: 'clamp(30px,4vw,44px)', margin: '14px 0 4px' }}
      >
        Under the lights.
      </h1>

      <div className="script">
        {state.transcript.map((turn, index) => (
          <div key={index}>
            <Line who="The Interviewer" kind="q" text={turn.question} />
            <Line who="You" kind="a" text={`"${turn.answer}"`} />
          </div>
        ))}

        {showTypedQuestion && state.currentQuestion && (
          <div className="line q" aria-hidden="true">
            <div className="char">The Interviewer</div>
            <div className="say">
              <TypewrittenLine text={state.currentQuestion} onShown={() => follow('instant')} />
            </div>
          </div>
        )}

        {voiceEnabled && awaitingAnswer && state.currentQuestion && (
          <div className="line q" aria-hidden="true">
            <div className="char">The Interviewer</div>
            <div className="say">
              {visibleVoiceQuestion}
              {!voiceSettled && <span className="caret" />}
            </div>
          </div>
        )}

        {awaitingLevel && state.levelPrompt && (
          <Line who="The Interviewer" kind="q" text={state.levelPrompt} />
        )}

        {state.closingMessage && (
          <div className="line q" aria-hidden="true">
            <div className="char">The Interviewer</div>
            <div className="say">
              {voiceEnabled ? (
                <>
                  {state.closingRevealed ? state.closingMessage : visibleVoiceClosing}
                  {!closingVisuallySettled && !closingDelivery.settled && (
                    <span className="caret" />
                  )}
                </>
              ) : (
                <TypewrittenLine
                  text={state.closingMessage}
                  // A remount after the goodbye already landed shows it whole, no retype.
                  initialCount={state.closingRevealed ? state.closingMessage.length : 0}
                  onShown={onClosingShown}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {grading && state.reportPreview && closingRevealed && (
        <p className="report-preview">
          {state.reportPreview}
          <span className="caret" />
        </p>
      )}

      {voiceEnabled && streaming && (
        <div className="cueing">
          <span className="sp" />
          Preparing the next question…
        </div>
      )}

      {state.cue && !awaitingAnswer && !awaitingLevel && !streaming && closingRevealed && (
        <div className="cueing" role="status">
          <span className="sp" />
          {state.cue}
        </div>
      )}

      {answerAvailable && (
        <CueCard
          key="answer"
          label="Your answer"
          placeholder="Deliver your line. The specifics, in your own voice."
          tip="Play it like the real thing. Detail beats polish."
          onDeliver={onSubmitAnswer}
        />
      )}

      {awaitingLevel && <LevelPicker onPick={onSubmitLevel} />}
    </>
  );
}

interface TimedSpeechDelivery {
  id: string | null;
  visibleText: string;
  settled: boolean;
}

/** Share alignment-driven browser delivery between questions and the closing. */
function useTimedSpeechDelivery({
  id,
  text,
  controller,
  reducedMotion,
  onSettled,
}: {
  id: string | null;
  text: string;
  controller?: QuestionSpeechController;
  reducedMotion: boolean;
  onSettled?: () => void;
}): TimedSpeechDelivery {
  const [delivery, setDelivery] = useState<TimedSpeechDelivery>({
    id: null,
    visibleText: '',
    settled: false,
  });
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  useEffect(() => {
    if (!id || !controller) return;
    let current = true;
    const settle = () => {
      if (!current) return;
      setDelivery({ id, visibleText: text, settled: true });
      onSettledRef.current?.();
    };
    void controller
      .speak({
        id,
        text,
        onPlaybackStart: () => {
          if (current && reducedMotion) {
            setDelivery({ id, visibleText: text, settled: false });
          }
        },
        onProgress: (prefix) => {
          if (current && !reducedMotion) {
            setDelivery({ id, visibleText: prefix, settled: false });
          }
        },
      })
      .then(settle, settle);
    return () => {
      current = false;
      controller.release(id);
    };
  }, [controller, id, reducedMotion, text]);

  return delivery.id === id ? delivery : { id, visibleText: '', settled: false };
}

function sceneMeta(state: InterviewState): string {
  const parts = ['The scene'];
  if (state.report?.role) parts.push(state.report.role);
  if (state.report?.company) parts.push(state.report.company);
  return parts.join(' · ');
}

/** Reveal pace for a typed line: 2 characters every 24ms (~80 chars a second). */
const TYPE_CHARS = 2;
const TYPE_INTERVAL_MS = 24;

/**
 * Type a line out at a steady pace instead of stamping it: the current question, or
 * the closing goodbye. The model's stream arrives in coarse chunks — and the
 * authoritative suspend delivers the full text at once — so a fixed reveal rate is
 * what makes the line feel delivered; the reveal trails whatever text has actually
 * arrived and catches up to it. `onShown` reports how far the reveal has got, so the
 * screen can hold the next beat until the line lands; `initialCount` starts the reveal
 * mid-text (a remount of an already-delivered line shows it whole).
 */
function TypewrittenLine({
  text,
  onShown,
  initialCount = 0,
}: {
  text: string;
  onShown?: (count: number) => void;
  initialCount?: number;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [count, setCount] = useState(initialCount);
  // One interval lives for the whole line (the component unmounts between questions).
  // It reads the latest text through a ref so a burst of arriving deltas never resets
  // the pacing timer; a caught-up tick is a no-op state set, which React bails out of
  // re-rendering.
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    // Reduced motion: no per-character reveal — the line is stamped whole below.
    if (reducedMotion) return;
    const id = setInterval(() => {
      setCount((current) =>
        current >= textRef.current.length
          ? current
          : Math.min(current + TYPE_CHARS, textRef.current.length),
      );
    }, TYPE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [reducedMotion]);

  const shown = reducedMotion ? text.length : Math.min(count, text.length);
  const onShownRef = useRef(onShown);
  useEffect(() => {
    onShownRef.current = onShown;
  }, [onShown]);
  useEffect(() => {
    onShownRef.current?.(shown);
  }, [shown, text]);

  return (
    <>
      {text.slice(0, shown)}
      {shown < text.length && <span className="caret" />}
    </>
  );
}

function Line({ who, kind, text }: { who: string; kind: 'q' | 'a'; text: string }) {
  return (
    <div className={`line ${kind}`}>
      <div className="char">{who}</div>
      <div className="say">{text}</div>
    </div>
  );
}

/** The seniority levels offered when the run suspends to ask for one. */
const LEVELS = ['junior', 'mid-level', 'senior', 'staff'];

function LevelPicker({ onPick }: { onPick: (level: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  // Same synchronous latch as the answer card: a double-click delivers the level once.
  const deliveredRef = useRef(false);

  function deliver() {
    if (!selected || deliveredRef.current) return;
    deliveredRef.current = true;
    setSent(true);
    onPick(selected);
  }

  return (
    <div className="cuecard">
      <div className="levels" role="group" aria-label="Target level">
        {LEVELS.map((level) => (
          <button
            key={level}
            className={`level-chip${selected === level ? ' selected' : ''}`}
            type="button"
            aria-pressed={selected === level}
            disabled={sent}
            onClick={() => setSelected(level)}
          >
            {level}
          </button>
        ))}
      </div>
      <div className="row">
        <span className="tip">The seniority bar the interview should calibrate to.</span>
        <button className="deliver" type="button" disabled={!selected || sent} onClick={deliver}>
          Deliver ▸
        </button>
      </div>
    </div>
  );
}

interface CueCardProps {
  label: string;
  placeholder: string;
  tip: string;
  onDeliver: (value: string) => void;
}

function CueCard({ label, placeholder, tip, onDeliver }: CueCardProps) {
  const [value, setValue] = useState('');
  const [sent, setSent] = useState(false);
  // A synchronous latch: two clicks landing in the same tick (before `sent` re-renders
  // the button disabled) still deliver the line exactly once.
  const deliveredRef = useRef(false);

  function deliver() {
    const trimmed = value.trim();
    if (!trimmed || deliveredRef.current) return;
    deliveredRef.current = true;
    setSent(true);
    onDeliver(trimmed);
    setValue('');
  }

  return (
    <div className="cuecard">
      <div className="frame">
        <textarea
          aria-label={label}
          placeholder={placeholder}
          value={value}
          disabled={sent}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <div className="row">
        <span className="tip">{tip}</span>
        <button
          className="deliver"
          type="button"
          disabled={sent || value.trim().length === 0}
          onClick={deliver}
        >
          Deliver ▸
        </button>
      </div>
    </div>
  );
}
