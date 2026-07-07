import { useState } from 'react';

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
              {state.currentQuestion}
              {streaming && <span className="caret" />}
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

      {awaitingLevel && (
        <CueCard
          key="level"
          label="Target level"
          placeholder="e.g. senior, staff, principal"
          tip="The seniority bar the interview should calibrate to."
          singleLine
          onDeliver={onSubmitLevel}
        />
      )}
    </>
  );
}

function sceneMeta(state: InterviewState): string {
  const parts = ['The scene'];
  if (state.report?.role) parts.push(state.report.role);
  if (state.report?.company) parts.push(state.report.company);
  return parts.join(' · ');
}

function Line({ who, kind, text }: { who: string; kind: 'q' | 'a'; text: string }) {
  return (
    <div className={`line ${kind}`}>
      <div className="char">{who}</div>
      <div className="say">{text}</div>
    </div>
  );
}

interface CueCardProps {
  label: string;
  placeholder: string;
  tip: string;
  singleLine?: boolean;
  onDeliver: (value: string) => void;
}

function CueCard({ label, placeholder, tip, singleLine = false, onDeliver }: CueCardProps) {
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
        {singleLine ? (
          <input
            type="text"
            aria-label={label}
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                deliver();
              }
            }}
          />
        ) : (
          <textarea
            aria-label={label}
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
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
