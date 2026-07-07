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
  from?: 'AGENT' | 'WORKFLOW' | string;
  payload?: unknown;
  runId?: string;
}

/** Which part of the UI the currently-active workflow step feeds tokens to. */
type ActiveSection = 'question' | 'report' | null;

interface StepCue {
  match: RegExp;
  label: string;
  section: ActiveSection;
}

// Ordered most-specific first; the first match wins. Labels mirror the approved
// design's stage cues. `section` decides where an agent's tokens are rendered while
// that step runs.
const STEP_CUES: StepCue[] = [
  { match: /ingest|profile|\bcv\b/i, label: 'Reading your CV', section: null },
  { match: /role/i, label: 'Sizing up the role', section: null },
  { match: /research|company/i, label: 'Researching the company', section: null },
  { match: /director/i, label: 'Choosing the next question…', section: 'question' },
  { match: /interview|question|turn/i, label: 'Writing the question…', section: 'question' },
  { match: /assess/i, label: 'Weighing your answer…', section: null },
  { match: /grade/i, label: 'Grading your answers…', section: 'report' },
  { match: /coach|report/i, label: "Writing the director's notes…", section: 'report' },
];

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
    next(chunk: StreamChunk): InterviewEvent | null {
      const stepId = readStepId(chunk);
      if (stepId !== undefined) {
        const cue = STEP_CUES.find((c) => c.match.test(stepId));
        if (!cue) return null;
        section = cue.section;
        return { type: 'cue', label: cue.label };
      }

      const text = readTextDelta(chunk);
      if (text) {
        if (section === 'question') return { type: 'question-delta', text };
        if (section === 'report') return { type: 'report-delta', text };
      }

      return null;
    },
  };
}

/** Read a workflow step id from a step-transition chunk, probing known field paths. */
function readStepId(chunk: StreamChunk): string | undefined {
  if (chunk.from && chunk.from !== 'WORKFLOW') return undefined;
  const p = asRecord(chunk.payload);
  if (!p) return undefined;
  const current = asRecord(p.currentStep);
  const id =
    (current && typeof current.id === 'string' && current.id) ||
    (typeof p.stepId === 'string' && p.stepId) ||
    (typeof p.id === 'string' && p.id);
  return id || undefined;
}

/** Read a token of streamed agent text, probing the known delta field paths. */
function readTextDelta(chunk: StreamChunk): string | undefined {
  if (chunk.from && chunk.from !== 'AGENT') return undefined;
  if (chunk.type && !/text|delta/i.test(chunk.type)) return undefined;
  const p = asRecord(chunk.payload);
  if (!p) return undefined;
  for (const key of ['textDelta', 'text', 'delta'] as const) {
    if (typeof p[key] === 'string' && p[key]) return p[key] as string;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
