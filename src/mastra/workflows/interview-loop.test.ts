import { describe, expect, it } from 'vitest';

import { Mastra } from '@mastra/core';
import { createWorkflow } from '@mastra/core/workflows';
import { createWorkflowStateReader } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';

import { answerAssessmentSchema } from '../schemas/answer-assessment';
import { candidateProfileSchema } from '../schemas/candidate-profile';
import { EMPTY_COMPANY_BRIEF } from '../schemas/company-brief';
import { directorDecisionSchema } from '../schemas/director-decision';
import { roleContextSchema } from '../schemas/role-context';
import type { BrainFactory, ClosingFactory } from '../interview/adaptive-brain';
import { INITIAL_COVERAGE, capLimitsSchema } from '../interview/interview-caps';
import { buildModelRequestContext, getTierModel, resolveModelTiers } from '../model-config';
import {
  asInterviewSuspend,
  closedInterviewStateSchema,
  interviewStateSchema,
  readSuspendPayload,
  researchOutputSchema,
} from './interview-state';
import {
  collectLevelStep,
  createClosingStep,
  createInterviewTurnStep,
  interviewLoopDone,
} from './steps/interview-loop';

// A deterministic brain: each turn opens a fresh topic (so successive questions differ),
// and the assessor returns a fixed read. This exercises the real loop mechanics —
// decide → question → suspend/resume → assess → append — without any model calls.
const fakeBrainFactory: BrainFactory = () => ({
  decide: async (state) =>
    directorDecisionSchema.parse({
      action: 'new_topic',
      subject: `topic ${state.coverage.questionCount + 1}`,
    }),
  question: async (state) => `Question ${state.coverage.questionCount + 1}`,
  assess: async () =>
    answerAssessmentSchema.parse({
      star: { situation: true, task: true, action: true, result: true, quantifiedResult: false },
      sufficientSignal: false,
    }),
});

const interviewTurnStep = createInterviewTurnStep(fakeBrainFactory);

// A self-contained workflow of the real interview-loop steps, backed by a real
// (in-memory) LibSQL store so suspend/resume is genuinely durable — but seeded past
// ingest/research so it needs no model calls. This exercises the exact steps the
// production `interviewWorkflow` chains after research.
const loopWorkflow = createWorkflow({
  id: 'interviewLoopTest',
  inputSchema: researchOutputSchema,
  outputSchema: interviewStateSchema,
})
  .then(collectLevelStep)
  .dountil(interviewTurnStep, async (context) => interviewLoopDone(context))
  .commit();

// A brain that wraps up on the first move, so the fresh pass ends the loop without ever
// asking a question — the director-driven termination path, distinct from cap exhaustion.
const wrapUpTurnStep = createInterviewTurnStep(() => ({
  decide: async () => directorDecisionSchema.parse({ action: 'wrap_up' }),
  question: async () => {
    throw new Error('the interviewer must not be asked once the director has wrapped up');
  },
  assess: async () => {
    throw new Error('the assessor must not run once the director has wrapped up');
  },
}));

const wrapUpWorkflow = createWorkflow({
  id: 'interviewWrapUpTest',
  inputSchema: researchOutputSchema,
  outputSchema: interviewStateSchema,
})
  .then(collectLevelStep)
  .dountil(wrapUpTurnStep, async (context) => interviewLoopDone(context))
  .commit();

// A brain whose director fails on its first consultation and works afterwards: the
// fresh pass hits the failure, the retried pass succeeds. Mirrors a transient
// provider fault surviving structuredCall's bounded retries.
let directorFailuresLeft = 1;
const failFreshTurnStep = createInterviewTurnStep(() => ({
  decide: async (state) => {
    if (directorFailuresLeft > 0) {
      directorFailuresLeft -= 1;
      throw new Error('director unavailable (simulated 429)');
    }
    return directorDecisionSchema.parse({
      action: 'new_topic',
      subject: `topic ${state.coverage.questionCount + 1}`,
    });
  },
  question: async (state) => `Question ${state.coverage.questionCount + 1}`,
  assess: async () =>
    answerAssessmentSchema.parse({
      star: { situation: true, task: true, action: true, result: true, quantifiedResult: false },
      sufficientSignal: false,
    }),
}));

const failFreshWorkflow = createWorkflow({
  id: 'interviewFailFreshTest',
  inputSchema: researchOutputSchema,
  outputSchema: interviewStateSchema,
})
  .then(collectLevelStep)
  .dountil(failFreshTurnStep, async (context) => interviewLoopDone(context))
  .commit();

// A brain whose assessor fails on its first read and works afterwards: the failure
// lands on the resume pass, after the candidate has already answered — the payload
// must carry that answer so the retry replays it instead of re-asking.
let assessorFailuresLeft = 1;
const failResumeTurnStep = createInterviewTurnStep(() => ({
  decide: async (state) =>
    directorDecisionSchema.parse({
      action: 'new_topic',
      subject: `topic ${state.coverage.questionCount + 1}`,
    }),
  question: async (state) => `Question ${state.coverage.questionCount + 1}`,
  assess: async () => {
    if (assessorFailuresLeft > 0) {
      assessorFailuresLeft -= 1;
      throw new Error('assessor unavailable (simulated 429)');
    }
    return answerAssessmentSchema.parse({
      star: { situation: true, task: true, action: true, result: true, quantifiedResult: false },
      sufficientSignal: false,
    });
  },
}));

const failResumeWorkflow = createWorkflow({
  id: 'interviewFailResumeTest',
  inputSchema: researchOutputSchema,
  outputSchema: interviewStateSchema,
})
  .then(collectLevelStep)
  .dountil(failResumeTurnStep, async (context) => interviewLoopDone(context))
  .commit();

// A brain factory that records the smart-tier router string it would hand the director
// each time a turn pass constructs it — the probe for tier inheritance across resumes.
const seenSmartTiers: string[] = [];
const tierProbeTurnStep = createInterviewTurnStep((_registry, requestContext) => {
  seenSmartTiers.push(getTierModel(requestContext, 'smart'));
  return {
    decide: async (state) =>
      directorDecisionSchema.parse({
        action: 'new_topic',
        subject: `topic ${state.coverage.questionCount + 1}`,
      }),
    question: async (state) => `Question ${state.coverage.questionCount + 1}`,
    assess: async () =>
      answerAssessmentSchema.parse({
        star: { situation: true, task: true, action: true, result: true, quantifiedResult: false },
        sufficientSignal: false,
      }),
  };
});

const tierProbeWorkflow = createWorkflow({
  id: 'interviewTierProbeTest',
  inputSchema: researchOutputSchema,
  outputSchema: interviewStateSchema,
})
  .then(collectLevelStep)
  .dountil(tierProbeTurnStep, async (context) => interviewLoopDone(context))
  .commit();

const mastra = new Mastra({
  workflows: { loopWorkflow, wrapUpWorkflow, failFreshWorkflow, failResumeWorkflow, tierProbeWorkflow },
  storage: new LibSQLStore({ id: 'loop-test', url: ':memory:' }),
});

const smallCaps = capLimitsSchema.parse({
  maxQuestions: 2,
  maxConsecutiveFollowUps: 2,
  maxReprompts: 1,
  tokenBudget: 1_000_000,
});

/** The question text of a suspended turn, or throw if it isn't a question suspension. */
function questionText(suspendPayload: unknown): string {
  const payload = readSuspendPayload(suspendPayload);
  if (payload?.kind !== 'question') throw new Error('expected a question suspension');
  return payload.question;
}

function seed(overrides: { targetLevel?: string } = {}) {
  return {
    profile: candidateProfileSchema.parse({ name: 'Ada Lovelace' }),
    roleContext: roleContextSchema.parse({ role: 'Staff Engineer' }),
    candidateId: 'candidate-loop-test',
    candidateIdOrigin: 'default' as const,
    threadId: 'thread-loop-test',
    researchUrls: [],
    companyBrief: EMPTY_COMPANY_BRIEF,
    limits: smallCaps,
    ...overrides,
  };
}

describe('interview turn loop', () => {
  it('ends the loop without asking when the director wraps up, leaving the transcript empty', async () => {
    const run = await mastra.getWorkflow('wrapUpWorkflow').createRun();
    const result = await run.start({ inputData: seed({ targetLevel: 'senior' }) });

    // A wrap_up on the first move ends the loop on the fresh pass: no suspension, no
    // question, no assessment — the run completes straight away with nothing recorded.
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.result.done).toBe(true);
    expect(result.result.transcript).toEqual([]);
    expect(result.result.assessments).toEqual([]);
    expect(result.result.coverage.questionCount).toBe(0);
  });

  it('suspends with the first question when the level is already set', async () => {
    const run = await mastra.getWorkflow('loopWorkflow').createRun();
    const result = await run.start({ inputData: seed({ targetLevel: 'senior' }) });

    expect(result.status).toBe('suspended');
    if (result.status !== 'suspended') return;
    const payload = readSuspendPayload(result.suspendPayload);
    expect(payload).toMatchObject({ kind: 'question', questionNumber: 1 });
    expect(payload?.kind === 'question' && typeof payload.question).toBe('string');
  });

  it('appends each answered turn to the transcript and ends when the question cap is hit', async () => {
    const run = await mastra.getWorkflow('loopWorkflow').createRun();
    let result = await run.start({ inputData: seed({ targetLevel: 'senior' }) });

    expect(result.status).toBe('suspended');
    if (result.status !== 'suspended') return;
    const firstQuestion = questionText(result.suspendPayload);

    result = await run.resume({ resumeData: { answer: 'My first answer.' } });
    expect(result.status).toBe('suspended');
    if (result.status !== 'suspended') return;
    // The second turn asks a distinct question — the loop advanced.
    const secondQuestion = questionText(result.suspendPayload);
    expect(secondQuestion).not.toBe(firstQuestion);

    result = await run.resume({ resumeData: { answer: 'My second answer.' } });
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;

    // Both questions are asserted against the values captured from the suspensions,
    // not read back from the result itself — so the transcript is genuinely checked.
    expect(result.result.transcript).toEqual([
      { question: firstQuestion, answer: 'My first answer.' },
      { question: secondQuestion, answer: 'My second answer.' },
    ]);
    expect(result.result.transcript).toHaveLength(2);
    expect(result.result.coverage.questionCount).toBe(2);
    expect(result.result.done).toBe(true);

    // The assessor ran once per answered turn, appending to the log the director reads,
    // each entry tagged with the topic that turn opened.
    expect(result.result.assessments).toHaveLength(2);
    expect(result.result.assessments.map((entry) => entry.topic)).toEqual(['topic 1', 'topic 2']);
    expect(result.result.currentTopic).toBe('topic 2');
  });

  it('records the exact question that was asked, read back from suspend data on resume', async () => {
    const run = await mastra.getWorkflow('loopWorkflow').createRun();
    let result = await run.start({ inputData: seed({ targetLevel: 'senior' }) });
    if (result.status !== 'suspended') throw new Error('expected suspension');
    const askedQuestion = questionText(result.suspendPayload);

    result = await run.resume({ resumeData: { answer: 'Answer one.' } });
    if (result.status !== 'suspended') throw new Error('expected second suspension');
    result = await run.resume({ resumeData: { answer: 'Answer two.' } });
    if (result.status !== 'success') throw new Error('expected success');

    // The resume pass has no question-regeneration fallback (it throws if the suspend
    // data is missing), so the recorded question can only have come from the suspend
    // payload captured above — this equality genuinely verifies the read-back path.
    expect(result.result.transcript[0]!.question).toBe(askedQuestion);
  });

  it('suspends for the target level when it is unset, then proceeds once resumed', async () => {
    const run = await mastra.getWorkflow('loopWorkflow').createRun();
    const first = await run.start({ inputData: seed() });

    expect(first.status).toBe('suspended');
    if (first.status !== 'suspended') return;
    expect(readSuspendPayload(first.suspendPayload)).toMatchObject({ kind: 'level' });

    const afterLevel = await run.resume({ resumeData: { level: 'staff' } });
    expect(afterLevel.status).toBe('suspended');
    if (afterLevel.status !== 'suspended') return;
    expect(readSuspendPayload(afterLevel.suspendPayload)).toMatchObject({
      kind: 'question',
      questionNumber: 1,
    });
  });
});

describe('suspend-on-failure durability', () => {
  it('suspends with a failure payload when the fresh pass fails, and a retry resume recovers', async () => {
    const run = await mastra.getWorkflow('failFreshWorkflow').createRun();
    const failed = await run.start({ inputData: seed({ targetLevel: 'senior' }) });

    // The director fault does not fail the run — it suspends with a failure payload,
    // so the session is resumable rather than dead.
    expect(failed.status).toBe('suspended');
    if (failed.status !== 'suspended') return;
    const payload = readSuspendPayload(failed.suspendPayload);
    expect(payload).toMatchObject({ kind: 'failure', stage: 'director' });
    if (payload?.kind !== 'failure') return;
    expect(payload.reason).toContain('director');
    expect(payload.pending).toBeUndefined();

    // Retrying the turn re-runs the fresh pass and asks the first question.
    const retried = await run.resume({ resumeData: { retry: true } });
    expect(retried.status).toBe('suspended');
    if (retried.status !== 'suspended') return;
    expect(readSuspendPayload(retried.suspendPayload)).toMatchObject({
      kind: 'question',
      questionNumber: 1,
    });
  });

  it('carries the pending answer through a resume-pass failure so it is never re-asked', async () => {
    const run = await mastra.getWorkflow('failResumeWorkflow').createRun();
    let result = await run.start({ inputData: seed({ targetLevel: 'senior' }) });
    if (result.status !== 'suspended') throw new Error('expected first question');
    const firstQuestion = questionText(result.suspendPayload);

    // The answer arrives, then the assessor faults: the run must suspend with the
    // answered turn intact in the payload, not lose it or fail the run.
    result = await run.resume({ resumeData: { answer: 'My first answer.' } });
    expect(result.status).toBe('suspended');
    if (result.status !== 'suspended') return;
    const payload = readSuspendPayload(result.suspendPayload);
    expect(payload).toMatchObject({ kind: 'failure', stage: 'assessor' });
    if (payload?.kind !== 'failure') return;
    expect(payload.pending).toMatchObject({
      question: firstQuestion,
      answer: 'My first answer.',
    });

    // The retry replays the stored turn — assess only, never re-asking — and the loop
    // continues to the second question.
    result = await run.resume({ resumeData: { retry: true } });
    expect(result.status).toBe('suspended');
    if (result.status !== 'suspended') return;
    const secondQuestion = questionText(result.suspendPayload);
    expect(secondQuestion).not.toBe(firstQuestion);

    // Finishing the interview shows the replayed turn exactly once, with the original
    // question and the answer that survived the failure.
    result = await run.resume({ resumeData: { answer: 'My second answer.' } });
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.result.transcript).toEqual([
      { question: firstQuestion, answer: 'My first answer.' },
      { question: secondQuestion, answer: 'My second answer.' },
    ]);
    expect(result.result.assessments).toHaveLength(2);
  });
});

describe('model-tier inheritance across resume', () => {
  it('a bare cross-process resume keeps the tiers the run started with', async () => {
    // Start with deliberately non-default tiers riding the request context.
    const tiers = resolveModelTiers({
      provider: 'probe',
      fastModel: 'fast-model-x',
      smartModel: 'smart-model-x',
    });
    const workflow = mastra.getWorkflow('tierProbeWorkflow');
    const run = await workflow.createRun();
    const started = await run.start({
      inputData: seed({ targetLevel: 'senior' }),
      requestContext: buildModelRequestContext(tiers),
    });
    expect(started.status).toBe('suspended');
    expect(seenSmartTiers.at(-1)).toBe('probe/smart-model-x');

    // Reattach by runId — a fresh process — and resume with NO model flags: the
    // engine merges the snapshot's request context into the bare resume, so the
    // session keeps the models it started with. That consistency is the contract
    // the `resume` command relies on by exposing no model flags.
    const reconnected = await workflow.createRun({ runId: run.runId });
    const resumed = await reconnected.resume({ resumeData: { answer: 'Answer one.' } });
    expect(resumed.status).toBe('suspended');
    expect(seenSmartTiers.at(-1)).toBe('probe/smart-model-x');
  });
});

// The static line the closing step falls back to when the agent fails, over a
// non-empty transcript. Mirrors `staticClosing` for a transcript with turns.
const STATIC_CLOSING = 'That covers what I wanted to ask. Thanks for walking me through it today.';

/** A single text chunk (`text-start`/`text-delta`/`text-end`) the closing step wrote. */
interface EmittedTextChunk {
  type: string;
  text?: string;
}

/**
 * Pull the closing step's own text chunks out of a captured run stream. A step's
 * `writer.write` chunks arrive wrapped in a `workflow-step-output` envelope under
 * `payload.output`; this unwraps them and keeps only the `text-*` chunks, in order.
 */
function emittedTextChunks(chunks: unknown[]): EmittedTextChunk[] {
  const out: EmittedTextChunk[] = [];
  for (const chunk of chunks) {
    if (typeof chunk !== 'object' || chunk === null) continue;
    const record = chunk as {
      type?: string;
      payload?: { output?: { type?: string; payload?: { text?: string } } };
    };
    if (record.type !== 'workflow-step-output') continue;
    const output = record.payload?.output;
    if (!output || typeof output.type !== 'string' || !output.type.startsWith('text-')) continue;
    out.push({ type: output.type, text: output.payload?.text });
  }
  return out;
}

/** A finished interview state ready for the closing step, with a non-empty transcript. */
function closingSeed() {
  return interviewStateSchema.parse({
    ...seed({ targetLevel: 'senior' }),
    transcript: [{ question: 'Walk me through a hard project.', answer: 'I led the migration.' }],
    coverage: INITIAL_COVERAGE,
    done: true,
  });
}

/** Run a one-step closing workflow to completion, capturing its stream chunks. */
async function runClosing(factory: ClosingFactory) {
  const step = createClosingStep(factory);
  const workflow = createWorkflow({
    id: 'closingBalanceTest',
    inputSchema: interviewStateSchema,
    outputSchema: closedInterviewStateSchema,
  })
    .then(step)
    .commit();
  const closingMastra = new Mastra({
    workflows: { closingBalanceTest: workflow },
    storage: new LibSQLStore({ id: 'closing-balance-test', url: ':memory:' }),
  });
  const run = await closingMastra.getWorkflow('closingBalanceTest').createRun();
  const output = run.stream({ inputData: closingSeed() });
  const chunks: unknown[] = [];
  for await (const chunk of output.fullStream) chunks.push(chunk);
  const result = await output.result;
  return { chunks, result };
}

describe('closing step stream balance', () => {
  it('emits a self-contained start/delta/end block on the fallback path so the failure branch leaves nothing open', async () => {
    // The agent fails before streaming anything: only the fallback branch writes.
    const failingClosing: ClosingFactory = () => async () => {
      throw new Error('closing agent unavailable');
    };

    const { chunks, result } = await runClosing(failingClosing);

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.result.closingMessage).toBe(STATIC_CLOSING);

    // The fallback writes a self-contained, balanced block: start, the static line, end.
    const text = emittedTextChunks(chunks);
    expect(text.map((c) => c.type)).toEqual(['text-start', 'text-delta', 'text-end']);
    expect(text[1]?.text).toBe(STATIC_CLOSING);
  });

  it('re-opens with a reset text-start after a partial stream so the client drops the truncated goodbye', async () => {
    // The agent streams a partial goodbye, then dies mid-stream — leaving an open block.
    const partialThenFail: ClosingFactory = (_registry, _requestContext, sink) => async () => {
      await sink?.write({ type: 'text-start', payload: {} });
      await sink?.write({ type: 'text-delta', payload: { text: 'A truncated goodbye that never fin' } });
      throw new Error('closing agent died mid-stream');
    };

    const { chunks, result } = await runClosing(partialThenFail);

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.result.closingMessage).toBe(STATIC_CLOSING);

    // The partial (start + delta) is followed by a fresh start — the reset marker the
    // client keys on to discard the truncated text — then the static line and a matched
    // end. No text block is left open.
    const text = emittedTextChunks(chunks);
    expect(text.map((c) => c.type)).toEqual([
      'text-start',
      'text-delta',
      'text-start',
      'text-delta',
      'text-end',
    ]);
    expect(text.at(-2)?.text).toBe(STATIC_CLOSING);
    expect(text.at(-1)?.type).toBe('text-end');
  });
});

describe('resume by runId', () => {
  it('reconnects to a suspended run through storage and continues with the transcript intact', async () => {
    const workflow = mastra.getWorkflow('loopWorkflow');
    const run = await workflow.createRun();
    const started = await run.start({ inputData: seed({ targetLevel: 'senior' }) });
    if (started.status !== 'suspended') throw new Error('expected suspension');
    const runId = run.runId;
    const firstQuestion = questionText(started.suspendPayload);

    // Answer the first turn, then "quit": drop the run object entirely.
    const midway = await run.resume({ resumeData: { answer: 'Answer before quitting.' } });
    if (midway.status !== 'suspended') throw new Error('expected second suspension');
    const secondQuestion = questionText(midway.suspendPayload);

    // Fresh reconnect by runId, as the `resume` command does. Read the pending
    // question from storage first, then rehydrate and resume.
    const state = await workflow.getWorkflowRunById(runId);
    expect(state).not.toBeNull();
    if (!state) return;
    const reader = createWorkflowStateReader(state);
    expect(reader.getStatus()).toBe('suspended');
    const pending = reader.getSuspendedStep();
    expect(asInterviewSuspend(pending?.suspendPayload)).toMatchObject({ kind: 'question' });

    const reconnected = await workflow.createRun({ runId });
    const finished = await reconnected.resume({ resumeData: { answer: 'Answer after resuming.' } });

    expect(finished.status).toBe('success');
    if (finished.status !== 'success') return;
    expect(finished.result.transcript).toEqual([
      { question: firstQuestion, answer: 'Answer before quitting.' },
      { question: secondQuestion, answer: 'Answer after resuming.' },
    ]);
  });
});
