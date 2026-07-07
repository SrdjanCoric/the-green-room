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
import type { BrainFactory } from '../interview/adaptive-brain';
import { capLimitsSchema } from '../interview/interview-caps';
import {
  asInterviewSuspend,
  interviewStateSchema,
  readSuspendPayload,
  researchOutputSchema,
} from './interview-state';
import {
  collectLevelStep,
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

const mastra = new Mastra({
  workflows: { loopWorkflow, wrapUpWorkflow },
  storage: new LibSQLStore({ id: 'loop-test', url: ':memory:' }),
});

const smallCaps = capLimitsSchema.parse({
  maxQuestions: 2,
  maxConsecutiveFollowUps: 2,
  maxReprompts: 1,
  tokenBudget: 1_000_000,
});

/** The question text of a suspended turn, or throw if it isn't a question suspension. */
function questionText(suspendPayload: Record<string, unknown> | undefined): string {
  const payload = readSuspendPayload(suspendPayload);
  if (payload?.kind !== 'question') throw new Error('expected a question suspension');
  return payload.question;
}

function seed(overrides: { targetLevel?: string } = {}) {
  return {
    profile: candidateProfileSchema.parse({ name: 'Ada Lovelace' }),
    roleContext: roleContextSchema.parse({ role: 'Staff Engineer' }),
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
    expect(result.result.transcript[0].question).toBe(askedQuestion);
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
