import { useRef, useState } from 'react';

import type { EnsembleSelection, PostingInputKind } from '../lib/types';

/** What the setup form hands up when it validates. */
export interface SetupPayload {
  cv: File;
  job: string;
  postingKind: PostingInputKind;
  ensemble?: EnsembleSelection;
}

export interface SetupScreenProps {
  onBegin: (payload: SetupPayload) => void;
  /** True while the CV is uploading / the posting is resolving. */
  busy?: boolean;
  /** A preparation error to surface (upload or posting resolution failed). */
  error?: string | null;
}

const DEFAULT_ENSEMBLE: EnsembleSelection = {
  provider: 'anthropic',
  fastModel: 'claude-sonnet-4-6',
  smartModel: 'claude-opus-4-8',
};

/**
 * The audition setup: the CV (required), the role as a link or pasted text
 * (required), and an optional advanced "ensemble" that pins the model tiers. Mirrors
 * the approved design's copy and screen. The target level is not asked here — the run
 * asks for it as its first turn when it is not otherwise known.
 */
export function SetupScreen({ onBegin, busy = false, error }: SetupScreenProps) {
  const [cv, setCv] = useState<File | null>(null);
  const [postingKind, setPostingKind] = useState<PostingInputKind>('link');
  const [link, setLink] = useState('');
  const [paste, setPaste] = useState('');
  const [ensemble, setEnsemble] = useState<EnsembleSelection>(DEFAULT_ENSEMBLE);
  const [cvError, setCvError] = useState(false);
  const [jobError, setJobError] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const job = (postingKind === 'link' ? link : paste).trim();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const missingCv = !cv;
    const missingJob = job.length === 0;
    setCvError(missingCv);
    setJobError(missingJob);
    if (missingCv || missingJob || !cv) return;

    const changed =
      ensemble.provider !== DEFAULT_ENSEMBLE.provider ||
      ensemble.fastModel !== DEFAULT_ENSEMBLE.fastModel ||
      ensemble.smartModel !== DEFAULT_ENSEMBLE.smartModel;

    onBegin({ cv, job, postingKind, ensemble: changed ? ensemble : undefined });
  }

  return (
    <>
      <div className="act-slug">The audition</div>
      <div className="rule-orn" />
      <h1 className="title-xl">
        You, <span className="it">off book.</span>
      </h1>
      <p className="lede">
        Hand over your CV and the role you're up for. We'll learn your lines, block the scene, and run
        you through a mock behavioral interview that adapts to every answer, then give you the
        director's notes.
      </p>

      <form onSubmit={submit}>
        <div className="fld">
          <label htmlFor="cv-file">
            Your material <span className="reqtag">Required</span>
          </label>
          <div className="sub">Your CV, in PDF, Markdown, or plain text.</div>
          <div
            className={`stagebox${cv ? ' filled' : ''}`}
            onClick={() => fileInput.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click();
            }}
          >
            <div className="b">{cv ? cv.name : 'Bring it to the stage'}</div>
            <div className="s">{cv ? 'on its mark, click to replace' : 'click to choose your CV'}</div>
          </div>
          <input
            id="cv-file"
            ref={fileInput}
            type="file"
            aria-label="CV file"
            accept=".pdf,.txt,.md,.markdown,.text"
            className="hide"
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              setCv(file);
              if (file) setCvError(false);
            }}
          />
          {cvError && <div className="ferr">Bring your CV to the stage first.</div>}
        </div>

        <div className="fld">
          <label>
            The role <span className="reqtag">Required</span>
          </label>
          <div className="sub">
            The posting you're auditioning against, as a link we can read or pasted text.
          </div>
          <div className="seg">
            <button
              type="button"
              className={postingKind === 'link' ? 'on' : ''}
              onClick={() => setPostingKind('link')}
            >
              Link
            </button>
            <button
              type="button"
              className={postingKind === 'paste' ? 'on' : ''}
              onClick={() => setPostingKind('paste')}
            >
              Paste
            </button>
          </div>
          {postingKind === 'link' ? (
            <input
              type="url"
              aria-label="Posting link"
              placeholder="https://jobs.example.com/staff-engineer"
              value={link}
              onChange={(e) => {
                setLink(e.target.value);
                if (e.target.value.trim()) setJobError(false);
              }}
            />
          ) : (
            <textarea
              aria-label="Posting text"
              placeholder="Paste the posting text..."
              value={paste}
              onChange={(e) => {
                setPaste(e.target.value);
                if (e.target.value.trim()) setJobError(false);
              }}
            />
          )}
          {jobError && <div className="ferr">Add the posting so we can block the scene.</div>}
        </div>

        <details className="ens">
          <summary>
            The ensemble <span className="h">who plays each part · optional</span>
          </summary>
          <div className="ens-grid">
            <div className="full">
              <small>House / provider</small>
              <select
                aria-label="Provider"
                value={ensemble.provider}
                onChange={(e) => setEnsemble((s) => ({ ...s, provider: e.target.value }))}
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="google">Google</option>
              </select>
            </div>
            <div>
              <small>The understudies · fast tier</small>
              <select
                aria-label="Fast tier model"
                value={ensemble.fastModel}
                onChange={(e) => setEnsemble((s) => ({ ...s, fastModel: e.target.value }))}
              >
                <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                <option value="claude-haiku-4-5">claude-haiku-4-5</option>
              </select>
            </div>
            <div>
              <small>The leads · smart tier</small>
              <select
                aria-label="Smart tier model"
                value={ensemble.smartModel}
                onChange={(e) => setEnsemble((s) => ({ ...s, smartModel: e.target.value }))}
              >
                <option value="claude-opus-4-8">claude-opus-4-8</option>
                <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
              </select>
            </div>
            <p className="ens-note">
              The understudies read your CV, the role, and the company. The leads direct the questions,
              grade, and coach.
            </p>
          </div>
        </details>

        {error && <div className="ferr">{error}</div>}

        <button className="curtain-btn" type="submit" disabled={busy}>
          {busy ? 'Setting the stage…' : 'Raise the curtain'}
        </button>
      </form>
    </>
  );
}
