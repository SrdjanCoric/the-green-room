import { useFocusOnMount } from '../hooks/useFocusOnMount';

/** The three setup stage cues, in order, shown while the run sets the stage. */
const STAGE_CUES = [
  { label: 'Reading your CV', sub: 'learning your lines' },
  { label: 'Sizing up the role', sub: 'blocking the scene' },
  { label: 'Researching the company', sub: 'dressing the set' },
];

export interface LoadingScreenProps {
  /** The current cue label streamed from the run, used to light the active stage. */
  cue: string | null;
}

/**
 * "Setting the stage": the setup wait, shown with the real agent steps as stage cues so
 * a long wait shows its work. The active stage is derived from the live cue label; once
 * the run moves past setup, all three read as done.
 */
export function LoadingScreen({ cue }: LoadingScreenProps) {
  const activeIndex = STAGE_CUES.findIndex((c) => c.label === cue);
  // A cue past the three setup stages (e.g. "Loading the next question…") means all are done.
  const passedSetup = cue !== null && activeIndex === -1;
  const heading = useFocusOnMount<HTMLHeadingElement>();

  return (
    <>
      <div className="act-slug">Setting the stage</div>
      <div className="rule-orn" />
      <div className="setting">
        <h1 ref={heading} tabIndex={-1} className="title-xl" style={{ fontSize: 'clamp(34px,5vw,54px)' }}>
          Places, please.
        </h1>
        <ul className="cues" role="status">
          {STAGE_CUES.map((stageCue, index) => {
            const state = passedSetup || index < activeIndex ? 'done' : index === activeIndex ? 'active' : '';
            return (
              <li key={stageCue.label} className={state}>
                <span className="cue">Cue {index + 1}</span>
                <span>
                  <span className="lbl">{stageCue.label}</span>
                  <span className="sub2">{stageCue.sub}</span>
                </span>
                <span className="lamp" />
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
