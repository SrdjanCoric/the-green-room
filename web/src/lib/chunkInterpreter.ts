import type { InterviewEvent } from './types';

/**
 * A single Mastra workflow stream chunk. The wire type is deliberately loose
 * (`payload: any`), so this interpreter reads it defensively: it probes several
 * likely field paths and falls back to `null` rather than assuming a shape. The
 * authoritative question and report text never depend on it — those come from the
 * run's persisted state — so an unrecognised chunk only means one fewer streamed
 * token, never a wrong or missing result.
 */
export interface StreamChunk {
  type?: string;
  // The two known sources, kept as literals for documentation while still admitting
  // any other string the loose wire type may carry (`string & {}` preserves the hints).
  from?: 'AGENT' | 'WORKFLOW' | (string & {});
  payload?: unknown;
  runId?: string;
}

/** Which part of the UI the currently-active workflow step feeds tokens to. */
type ActiveSection = 'question' | 'closing' | 'report' | null;

interface StepCue {
  match: RegExp;
  label: string;
  section: ActiveSection;
  /** This step can only run after closing, so its start settles the complete goodbye. */
  settlesClosing?: boolean;
}

// Ordered most-specific first; the first match wins. Labels mirror the approved
// design's stage cues. `section` decides where an agent's tokens are rendered while
// that step runs.
const STEP_CUES: StepCue[] = [
  { match: /ingest|profile|\bcv\b/i, label: 'Reading your CV', section: null },
  { match: /role/i, label: 'Sizing up the role', section: null },
  { match: /research|company/i, label: 'Researching the company', section: null },
  { match: /director/i, label: 'Choosing the next question…', section: 'question' },
  { match: /interview|question|turn/i, label: 'Loading the next question…', section: 'question' },
  { match: /assess/i, label: 'Weighing your answer…', section: null },
  { match: /closing/i, label: 'Wrapping up…', section: 'closing' },
  {
    match: /grade/i,
    label: 'Grading your answers…',
    section: 'report',
    settlesClosing: true,
  },
  {
    match: /coach|report/i,
    label: 'Writing the coaching report…',
    section: 'report',
    settlesClosing: true,
  },
];

/** The cue shown for each stage the ingest step reports through its progress chunks. */
const INGEST_STAGE_CUES: Record<string, string> = {
  role: 'Sizing up the role',
};

export interface ChunkInterpreter {
  /** Interpret one chunk, returning a domain event or `null` when it carries no UI signal. */
  next(chunk: StreamChunk): InterviewEvent | null;
}

/**
 * Build a stateful interpreter for one stream. It tracks which workflow step is
 * active so agent token deltas can be routed to the question or the report.
 */
export function createChunkInterpreter(): ChunkInterpreter {
  let section: ActiveSection = null;

  return {
    next(outer: StreamChunk): InterviewEvent | null {
      const chunk = unwrapStepOutput(outer);

      // A step's own progress marker: ingest reports moving from the CV to the role.
      // The stage, not the chunk's mere presence, picks the cue — an unknown stage is
      // ignored rather than mislabeled.
      if (chunk.type === 'ingest-progress') {
        const stage = asRecord(chunk)?.stage;
        const label = typeof stage === 'string' ? INGEST_STAGE_CUES[stage] : undefined;
        return label ? { type: 'cue', label } : null;
      }

      const stepId = readStepId(chunk);
      if (stepId !== undefined) {
        const cue = STEP_CUES.find((c) => c.match.test(stepId));
        if (!cue) return null;
        section = cue.section;
        return cue.settlesClosing
          ? { type: 'closing-settled', cue: cue.label }
          : { type: 'cue', label: cue.label };
      }

      // A new reply opens: whatever streamed before it was a failed attempt's text.
      if (chunk.type === 'text-start') {
        if (section === 'question') return { type: 'question-start' };
        if (section === 'closing') return { type: 'closing-start' };
        if (section === 'report') return { type: 'report-start' };
        return null;
      }

      const text = readTextDelta(chunk);
      if (text) {
        if (section === 'question') return { type: 'question-delta', text };
        if (section === 'closing') return { type: 'closing-delta', text };
        if (section === 'report') return { type: 'report-delta', text };
      }

      return null;
    },
  };
}

/**
 * Unwrap a `workflow-step-output` envelope. A workflow step forwards nested chunks
 * (agent token deltas) through its `writer`, and each one arrives wrapped under
 * `payload.output`; envelopes can nest, so unwrap until a plain chunk surfaces.
 */
function unwrapStepOutput(chunk: StreamChunk): StreamChunk {
  let current = chunk;
  for (;;) {
    if (current.type !== 'workflow-step-output') return current;
    const output = asRecord(asRecord(current.payload)?.output);
    if (!output) return current;
    current = output;
  }
}

/** Read a workflow step id from a step-transition chunk, probing known field paths. */
function readStepId(chunk: StreamChunk): string | undefined {
  if (chunk.from && chunk.from !== 'WORKFLOW') return undefined;
  const p = asRecord(chunk.payload);
  if (!p) return undefined;
  const current = asRecord(p.currentStep);
  // Probe the known id field paths in order, skipping empty strings; `||`/`??` on the
  // mixed string|false|undefined intermediates would either misread or be flagged.
  if (current && typeof current.id === 'string' && current.id) return current.id;
  if (typeof p.stepId === 'string' && p.stepId) return p.stepId;
  if (typeof p.id === 'string' && p.id) return p.id;
  return undefined;
}

/** Read a token of streamed agent text, probing the known delta field paths. */
function readTextDelta(chunk: StreamChunk): string | undefined {
  if (chunk.from && chunk.from !== 'AGENT') return undefined;
  if (chunk.type && !/text|delta/i.test(chunk.type)) return undefined;
  const p = asRecord(chunk.payload);
  if (!p) return undefined;
  for (const key of ['textDelta', 'text', 'delta'] as const) {
    const value = p[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
