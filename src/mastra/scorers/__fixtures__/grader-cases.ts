import type { TranscriptExpectation } from '../grader-agreement';
import type { SessionGrade } from '../../schemas/coach-report';
import type { TranscriptEntry } from '../../schemas/interview';

/**
 * One committed, human-labeled grader case: a finished senior transcript, the expectations
 * a calibrated grader must meet on it, and two grades — one that meets them and one that
 * drifts — so the agreement scorer can be asserted deterministically, no model call. The
 * transcript also feeds the opt-in live `runEvals` smoke test, which runs the real grader
 * over it and scores the result against the same expectations.
 *
 * The four turns each exercise one calibration contract: a strong owned answer (floor),
 * a bare clarification (skip), a thin below-level answer (ceiling), and an evaded question
 * (dodge → 1). Turn indices are zero-based, matching the grade's `turnIndex`.
 */
export const graderCaseTranscript: TranscriptEntry[] = [
  {
    question:
      'Tell me about a hard piece of backend work you owned end to end - the situation and what you personally did.',
    answer:
      'At Coding School our checkout service fell over every enrollment rush because it wrote every order synchronously to one Postgres table. I owned the redesign: I moved order writes onto a queue, added an idempotency key so retries could not double-charge, and cut over one region at a time behind a flag. Peak write latency dropped from about 900ms to 120ms and we took the next rush with no incidents.',
  },
  {
    question: 'When you say "the next rush" - do you mean the following enrollment window?',
    answer: 'Yes, the next enrollment window, about four months after the cutover finished.',
  },
  {
    question: 'Tell me about a time you improved how your team worked.',
    answer: 'I set up some better tooling and things got easier for everyone after that.',
  },
  {
    question: 'Describe a project that failed and what you learned from it.',
    answer: "Honestly nothing really failed, our stuff mostly just works. I'd rather talk about the wins.",
  },
];

/** What a calibrated grader must do on {@link graderCaseTranscript}. */
export const graderCaseExpectation: TranscriptExpectation = {
  seniorFloorTurns: [0], // strong, quantified, clearly owned redesign
  seniorCeilingTurns: [2], // vague "things got easier", no concrete change
  clarifyingTurns: [1], // a bare confirmation, no answer of its own to grade
  declinedTurns: [],
  dodgeTurns: [3], // a fair failure question evaded, not answered
};

/**
 * A grade that meets every expectation: the owned answer scores a 4, the vague one a 3,
 * the evasion a 1, and the clarification is skipped rather than scored.
 */
export const agreeingGrade: SessionGrade = {
  scores: [
    {
      question: graderCaseTranscript[0]!.question,
      turnIndex: 0,
      rationale:
        'A complete STAR story with a clearly owned redesign and a quantified latency win; strong for senior, with only the business-impact framing left to push it to a 5.',
      star: { situation: true, task: true, action: true, result: true, quantifiedResult: true },
      specificity: 'high - names the service, the failure mode, the mechanism, and two numbers',
      ownership: 'clear - first-person active verbs throughout the redesign',
      weakOrMissing: [],
      gap: 'tie the latency win to a business outcome (revenue held, enrollments saved) to reach a 5',
      score: 4,
    },
    {
      question: graderCaseTranscript[2]!.question,
      turnIndex: 2,
      rationale:
        'Names no concrete tooling, no before/after, and no measured change - a vague claim of betterment that stays well below the senior bar.',
      star: { situation: false, task: false, action: true, result: false, quantifiedResult: false },
      specificity: 'low - leans on "better" and "easier" with nothing concrete behind it',
      ownership: 'unclear - "I set up some tooling" with no detail on what was theirs',
      weakOrMissing: ['no named tooling', 'no before/after or measured change'],
      gap: 'name the specific tooling and the concrete change it made, with a number if there is one',
      score: 3,
    },
    {
      question: graderCaseTranscript[3]!.question,
      turnIndex: 3,
      rationale:
        'A fair, answerable failure question the candidate evaded rather than answered, giving no incident to judge.',
      star: { situation: false, task: false, action: false, result: false, quantifiedResult: false },
      specificity: 'low - no example offered at all',
      ownership: 'not applicable - no work described',
      weakOrMissing: ['no situation, task, action, or result - the question went unanswered'],
      gap: 'answer the question asked: name a real project that fell short and what changed afterward',
      score: 1,
    },
  ],
  skipped: [
    {
      turnIndex: 1,
      question: graderCaseTranscript[1]!.question,
      reason: 'A bare clarification the candidate simply confirmed; no work of its own to grade.',
    },
  ],
};

/**
 * A drifted grade: it under-levels the strong answer (a 2, below the floor), scores the
 * clarification instead of skipping it, and lets the evasion off with a 4 instead of a 1 -
 * three separate disagreements the agreement scorer must catch.
 */
export const driftedGrade: SessionGrade = {
  scores: [
    {
      question: graderCaseTranscript[0]!.question,
      turnIndex: 0,
      rationale: 'Solid enough but I want more.',
      star: { situation: true, task: true, action: true, result: true, quantifiedResult: true },
      specificity: 'high',
      ownership: 'clear',
      weakOrMissing: [],
      gap: 'could go deeper',
      score: 2,
    },
    {
      question: graderCaseTranscript[1]!.question,
      turnIndex: 1,
      rationale: 'They confirmed the timing, which is fine.',
      star: { situation: false, task: false, action: false, result: false, quantifiedResult: false },
      specificity: 'low',
      ownership: 'not applicable',
      weakOrMissing: ['just a confirmation'],
      gap: 'not much to say here',
      score: 3,
    },
    {
      // The one turn this drifted grade still handles correctly: the vague answer stays
      // at or below the senior ceiling, so only the floor, skip, and dodge drift.
      question: graderCaseTranscript[2]!.question,
      turnIndex: 2,
      rationale: 'Vague, nothing concrete, well below the bar.',
      star: { situation: false, task: false, action: true, result: false, quantifiedResult: false },
      specificity: 'low',
      ownership: 'unclear',
      weakOrMissing: ['no named tooling', 'no measured change'],
      gap: 'name the tooling and the concrete change it made',
      score: 3,
    },
    {
      question: graderCaseTranscript[3]!.question,
      turnIndex: 3,
      rationale: 'They stayed positive about their work.',
      star: { situation: false, task: false, action: false, result: false, quantifiedResult: false },
      specificity: 'low',
      ownership: 'unclear',
      weakOrMissing: ['no failure described'],
      gap: 'a real example would help',
      score: 4,
    },
  ],
  skipped: [],
};
