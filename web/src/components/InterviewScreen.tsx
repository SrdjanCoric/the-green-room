import { useEffect, useRef, useState } from 'react';

import type { InterviewState } from '../lib/interviewMachine';

export interface InterviewScreenProps {
  state: InterviewState;
  onSubmitAnswer: (answer: string) => void;
  onSubmitLevel: (level: string) => void;
}

/**
 * The interview "scene": the streamed script of questions and answers, a between-turns
 * cue line while the run works, and the cue card the candidate delivers their line
 * into. When the run suspends for the target level, that turn asks for it instead.
 */
export function InterviewScreen({ state, onSubmitAnswer, onSubmitLevel }: InterviewScreenProps) {
  const streaming = state.phase === 'streamingQuestion';
  const awaitingAnswer = state.phase === 'awaitingAnswer';
  const awaitingLevel = state.phase === 'awaitingLevel';
  const grading = state.phase === 'grading';
  const showQuestion = streaming || awaitingAnswer;

  return (
    <>
      <div className="scene-meta">{sceneMeta(state)}</div>
      <h1 className="title-xl" style={{ fontSize: 'clamp(30px,4vw,44px)', margin: '14px 0 4px' }}>
        Under the lights.
      </h1>

      <div className="script">
        {state.transcript.map((turn, index) => (
          <div key={index}>
            <Line who="The Interviewer" kind="q" text={turn.question} />
            <Line who="You" kind="a" text={`"${turn.answer}"`} />
          </div>
        ))}

        {showQuestion && state.currentQuestion && (
          <div className="line q">
            <div className="char">The Interviewer</div>
            <div className="say">
              <TypewrittenQuestion text={state.currentQuestion} />
            </div>
          </div>
        )}

        {awaitingLevel && state.levelPrompt && (
          <Line who="The Interviewer" kind="q" text={state.levelPrompt} />
        )}
      </div>

      {grading && state.reportPreview && (
        <p className="report-preview">
          {state.reportPreview}
          <span className="caret" />
        </p>
      )}

      {state.cue && !awaitingAnswer && !awaitingLevel && (
        <div className="cueing">
          <span className="sp" />
          {state.cue}
        </div>
      )}

      {awaitingAnswer && (
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

function sceneMeta(state: InterviewState): string {
  const parts = ['The scene'];
  if (state.report?.role) parts.push(state.report.role);
  if (state.report?.company) parts.push(state.report.company);
  return parts.join(' · ');
}

/** Reveal pace for the question: 2 characters every 24ms (~80 chars a second). */
const TYPE_CHARS = 2;
const TYPE_INTERVAL_MS = 24;

/**
 * Type the current question out at a steady pace instead of stamping it. The model's
 * stream arrives in coarse chunks — and the authoritative suspend delivers the full
 * text at once — so a fixed reveal rate is what makes the question feel delivered;
 * the reveal trails whatever text has actually arrived and catches up to it.
 */
function TypewrittenQuestion({ text }: { text: string }) {
  const [count, setCount] = useState(0);
  // One interval lives for the whole question (the component unmounts between
  // questions). It reads the latest text through a ref so a burst of arriving
  // deltas never resets the pacing timer; a caught-up tick is a no-op state set,
  // which React bails out of re-rendering.
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    const id = setInterval(() => {
      setCount((current) =>
        current >= textRef.current.length
          ? current
          : Math.min(current + TYPE_CHARS, textRef.current.length),
      );
    }, TYPE_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const shown = Math.min(count, text.length);
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

  return (
    <div className="cuecard">
      <div className="levels" role="group" aria-label="Target level">
        {LEVELS.map((level) => (
          <button
            key={level}
            className={`level-chip${selected === level ? ' selected' : ''}`}
            type="button"
            aria-pressed={selected === level}
            onClick={() => setSelected(level)}
          >
            {level}
          </button>
        ))}
      </div>
      <div className="row">
        <span className="tip">The seniority bar the interview should calibrate to.</span>
        <button
          className="deliver"
          type="button"
          disabled={!selected}
          onClick={() => selected && onPick(selected)}
        >
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

  function deliver() {
    const trimmed = value.trim();
    if (!trimmed) return;
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
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <div className="row">
        <span className="tip">{tip}</span>
        <button className="deliver" type="button" onClick={deliver}>
          Deliver ▸
        </button>
      </div>
    </div>
  );
}
