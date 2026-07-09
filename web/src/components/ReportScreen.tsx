import { useEffect, useState } from 'react';

import { useFocusOnMount } from '../hooks/useFocusOnMount';
import type { InterviewReport } from '../lib/types';

export interface ReportScreenProps {
  report: InterviewReport;
  /** Optional save/export hook wired by the host (e.g. download the notes). */
  onSave?: () => void;
}

type Tab = 'coaching' | 'transcript';

/** The director's notes: the coaching tab and the transcript tab, plus a save control. */
export function ReportScreen({ report, onSave }: ReportScreenProps) {
  const [tab, setTab] = useState<Tab>('coaching');
  const [saved, setSaved] = useState(false);
  const { coaching, transcript } = report;
  const heading = useFocusOnMount<HTMLHeadingElement>();

  // The notes read from the top. Without this the page keeps the interview's scroll
  // position — the bottom, where the interview ended. Keyed on the report identity,
  // not the mount: opening another cached report only swaps the prop.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [report]);

  function save() {
    onSave?.();
    setSaved(true);
  }

  return (
    <>
      <div className="act-slug">The director's notes</div>
      <div className="rule-orn" />
      <h1 ref={heading} tabIndex={-1} className="title-xl" style={{ fontSize: 'clamp(38px,6vw,68px)' }}>
        Notes.
      </h1>

      <div className="tabs">
        <button className={tab === 'coaching' ? 'on' : ''} onClick={() => setTab('coaching')} type="button">
          The notes
        </button>
        <button
          className={tab === 'transcript' ? 'on' : ''}
          onClick={() => setTab('transcript')}
          type="button"
        >
          The script
        </button>
      </div>

      {tab === 'coaching' ? (
        <div>
          <p className="notes-verdict">{coaching.summary}</p>

          {coaching.answerAdvice.length > 0 && (
            <>
              <div className="note-sec">Scene by scene</div>
              {coaching.answerAdvice.map((advice, index) => (
                <div className="script-note" key={index}>
                  <div className="ql">{advice.question}</div>
                  <div className="dg">{advice.diagnosis}</div>
                  <div className="marg">
                    <b>Try:</b> {advice.fix}
                  </div>
                </div>
              ))}
            </>
          )}

          {coaching.drills.length > 0 && (
            <>
              <div className="note-sec">Exercises</div>
              {coaching.drills.map((drill, index) => (
                <div className="drill" key={index}>
                  <div className="f">{drill.focus}</div>
                  <div>{drill.exercise}</div>
                </div>
              ))}
            </>
          )}

          <div className="note-sec">Notes for next time</div>
          <p className="plan">{coaching.studyPlan}</p>

          <button className="curtain-btn" style={{ marginTop: 44 }} type="button" onClick={save} disabled={saved}>
            {saved ? 'Saved ✓' : 'Save the notes'}
          </button>
        </div>
      ) : (
        <div className="scriptpage">
          {transcript.map((turn, index) => (
            <div key={index}>
              <div className="line q">
                <div className="char">The Interviewer</div>
                <div className="say">{turn.question}</div>
              </div>
              <div className="line a">
                <div className="char">You</div>
                <div className="say">"{turn.answer}"</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
