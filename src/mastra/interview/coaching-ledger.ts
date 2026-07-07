import { z } from 'zod';

import { candidateProfileSchema } from '../schemas/candidate-profile';
import type { CoachReport, SessionGrade } from '../schemas/coach-report';
import type { RoleContext } from '../schemas/role-context';

/** Most sessions the ledger keeps per candidate; older entries are dropped first. */
export const SESSION_LEDGER_CAP = 10;

/**
 * One finished session, distilled for the coach: enough to call out repeats for a
 * returning candidate, small enough that ten of them stay a footnote in the prompt.
 * Every field is code-computed from the session's grade and coach report — the shape
 * is fixed by construction, never model-written, so the ledger cannot grow or drift.
 */
export const sessionSummarySchema = z.object({
  runId: z.string().describe('The workflow run this session summary distills.'),
  date: z.string().describe('ISO timestamp of when the session was coached.'),
  role: z.string().describe('The role (and company) the session interviewed for.'),
  questionCount: z.number().int().nonnegative(),
  averageScore: z.number().describe('Mean answer score for the session, one decimal.'),
  topGaps: z.array(z.string()).max(3).describe('Gaps from the lowest-scoring answers.'),
  drillFoci: z.array(z.string()).max(3).describe('The drills the coach prescribed.'),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/**
 * The candidate's resource-scoped working memory: the parsed profile plus the capped
 * session ledger. Working memory (not observational memory) is deliberate: this app
 * records no conversation messages for an observer to extract from — every insight
 * already exists as a validated structured object (grade, coach report), so the
 * ledger is distilled in code. Observational memory is the evaluated-and-deferred
 * alternative, revisited only if a conversational coach-chat surface is added, whose
 * message threads would be exactly what it is built for.
 */
export const candidateWorkingMemorySchema = z.object({
  profile: candidateProfileSchema,
  sessions: z.array(sessionSummarySchema).max(SESSION_LEDGER_CAP).default([]),
});

export type CandidateWorkingMemory = z.infer<typeof candidateWorkingMemorySchema>;

/**
 * Distill one coached session into its ledger entry. `topGaps` takes the non-blank
 * gap notes of the lowest-scoring answers; `drillFoci` the coach's drill focuses —
 * both capped at three.
 */
export function computeSessionSummary(params: {
  runId: string;
  date: string;
  roleContext: RoleContext;
  transcriptLength: number;
  grade: SessionGrade;
  coaching: CoachReport;
}): SessionSummary {
  const { grade, coaching, roleContext } = params;

  const scores = grade.scores.map((entry) => entry.score);
  const mean = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  const topGaps = [...grade.scores]
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.gap.trim())
    .filter((gap) => gap.length > 0)
    .slice(0, 3);

  const drillFoci = coaching.drills.map((drill) => drill.focus).slice(0, 3);

  return sessionSummarySchema.parse({
    runId: params.runId,
    date: params.date,
    role: roleContext.company ? `${roleContext.role} @ ${roleContext.company}` : roleContext.role,
    questionCount: params.transcriptLength,
    averageScore: Math.round(mean * 10) / 10,
    topGaps,
    drillFoci,
  });
}

/**
 * Upsert a session into the ledger: an entry with the same `runId` is replaced in
 * place (a `recoach` replay updates its own session rather than double-appending);
 * a new one is appended, dropping the oldest entries beyond the cap.
 */
export function upsertSessionSummary(
  sessions: SessionSummary[],
  summary: SessionSummary,
): SessionSummary[] {
  const index = sessions.findIndex((entry) => entry.runId === summary.runId);
  if (index >= 0) {
    const updated = [...sessions];
    updated[index] = summary;
    return updated;
  }
  return [...sessions, summary].slice(-SESSION_LEDGER_CAP);
}

/**
 * Parse a stored working-memory record. Tolerates the pre-ledger shape — a bare
 * candidate profile — by reading it as a ledger with no sessions, so an existing
 * candidate's record upgrades in place on their next session.
 */
export function parseCandidateWorkingMemory(
  stored: string | null,
): CandidateWorkingMemory | undefined {
  if (!stored) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return undefined;
  }
  const parsed = candidateWorkingMemorySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const legacy = candidateProfileSchema.safeParse(raw);
  if (legacy.success) return { profile: legacy.data, sessions: [] };
  return undefined;
}

/** Render the ledger into the plain-text block the coach prompt fences. */
export function renderPriorSessions(sessions: SessionSummary[]): string {
  return sessions
    .map((session) => {
      const day = session.date.slice(0, 10);
      const parts = [
        `${day} · ${session.role} · ${session.questionCount} questions · average score ${session.averageScore}/5`,
      ];
      if (session.topGaps.length > 0) parts.push(`gaps: ${session.topGaps.join(' | ')}`);
      if (session.drillFoci.length > 0) parts.push(`advised drills: ${session.drillFoci.join(' | ')}`);
      return `- ${parts.join('; ')}`;
    })
    .join('\n');
}
