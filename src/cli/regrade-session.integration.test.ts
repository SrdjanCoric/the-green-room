import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { answerAssessmentSchema } from '../mastra/schemas/answer-assessment';
import { candidateProfileSchema } from '../mastra/schemas/candidate-profile';
import { coachReportSchema, sessionGradeSchema } from '../mastra/schemas/coach-report';
import { EMPTY_COMPANY_BRIEF } from '../mastra/schemas/company-brief';
import { directorDecisionSchema } from '../mastra/schemas/director-decision';
import { roleContextSchema } from '../mastra/schemas/role-context';
import type { BrainFactory } from '../mastra/workflows/adaptive-brain';
import { buildModelRequestContext, resolveModelTiers } from '../mastra/model-config';
import { capLimitsSchema } from '../mastra/workflows/interview-caps';
import {
  closingStep,
  coachStep,
  collectLevelStep,
  createInterviewTurnStep,
  gradeStep,
  interviewLoopDone,
  interviewSnapshotPersistence,
  reportStep,
  reportedInterviewStateSchema,
  researchOutputSchema,
} from '../mastra/workflows/interview-workflow';
import {
  recoachSession,
  regradeSession,
  type InterviewWorkflowHandle,
} from './interview-session';

// Counters that let each test prove which work re-ran on a replay: the interview brain
// (director/interviewer/assessor) must NOT run again, while the grader and coach must.
const brainCalls = { decide: 0, question: 0, assess: 0 };
const graderCalls = { count: 0 };
const coachCalls = { count: 0 };

// Injected faults, so a test can drive a run to a terminal failure at a chosen phase:
// 'loop' fails inside the interview loop (before `closing`), 'grade' fails at the grade
// step (after `closing`). 'none' is the happy path.
let failMode: 'none' | 'loop' | 'grade' = 'none';

// A deterministic brain that also records every call, so a replay can assert no
// interview turn was re-executed. Each turn opens a fresh topic.
const spyBrainFactory: BrainFactory = () => ({
  decide: async (state) => {
    brainCalls.decide += 1;
    return directorDecisionSchema.parse({
      action: 'new_topic',
      subject: `topic ${state.coverage.questionCount + 1}`,
    });
  },
  question: async (state) => {
    brainCalls.question += 1;
    return `Question ${state.coverage.questionCount + 1}`;
  },
  assess: async () => {
    brainCalls.assess += 1;
    if (failMode === 'loop') throw new Error('injected loop failure');
    return answerAssessmentSchema.parse({
      star: { situation: true, task: true, action: true, result: true, quantifiedResult: false },
      sufficientSignal: false,
    });
  },
});

// A grade covering every transcript turn exactly once, so the grade step's
// transcript-coverage contract holds without a real model.
function gradeForTurns(turns: number) {
  return sessionGradeSchema.parse({
    scores: Array.from({ length: turns }, (_, index) => ({
      question: `Question ${index + 1}`,
      turnIndex: index,
      rationale: 'Recorded for the replay test.',
      star: { situation: true, task: true, action: true, result: true, quantifiedResult: false },
      specificity: 'medium',
      ownership: 'clear',
      weakOrMissing: ['a measured result'],
      gap: 'Quantify the outcome.',
      score: 3,
    })),
    skipped: [],
  });
}

// A real Agent whose model never runs — generate is overridden to return canned
// structured output, and the model function throws if the real path is ever reached.
function stubAgent(id: string, generate: Agent['generate']): Agent {
  const agent = new Agent({
    id,
    name: id,
    instructions: 'test stub',
    model: () => {
      throw new Error(`${id} model should not be invoked in this test`);
    },
  });
  agent.generate = generate;
  return agent;
}

const grader = stubAgent('grader', (async (_prompt: string, options: { structuredOutput?: unknown }) => {
  graderCalls.count += 1;
  if (failMode === 'grade') throw new Error('injected grade failure');
  const schema = (options.structuredOutput as { schema: { parse: (value: unknown) => unknown } }).schema;
  // The grade step passes a transcript-length-specific schema; size the grade to it.
  return { object: schema.parse(gradeForTurns(2)) };
}) as unknown as Agent['generate']);

const coach = stubAgent('coach', (async () => {
  coachCalls.count += 1;
  return {
    object: coachReportSchema.parse({
      summary: 'A candid read of the session.',
      answerAdvice: [{ question: 'Question 1', diagnosis: 'Thin on specifics.', fix: 'Add a metric.' }],
      drills: [],
      studyPlan: 'Work on quantifying outcomes.',
    }),
  };
}) as unknown as Agent['generate']);

const interviewTurnStep = createInterviewTurnStep(spyBrainFactory);

// The real post-interview chain (loop → closing → grade → coach → report) on a real
// in-memory durable store, seeded past ingest/research so no ingest models are called.
// It carries the exact production snapshot-persistence policy — imported, not copied —
// so this test cannot drift from the durability contract that makes the pre-grade
// boundary time-travellable.
const regradeWorkflow = createWorkflow({
  id: 'regradeWorkflowTest',
  inputSchema: researchOutputSchema,
  outputSchema: reportedInterviewStateSchema,
  options: {
    shouldPersistSnapshot: interviewSnapshotPersistence,
  },
})
  .then(collectLevelStep)
  .dountil(interviewTurnStep, async (context) => interviewLoopDone(context))
  .then(closingStep)
  .then(gradeStep)
  .then(coachStep)
  .then(reportStep)
  .commit();

const mastra = new Mastra({
  agents: { grader, coach },
  workflows: { regradeWorkflow },
  storage: new LibSQLStore({ id: 'regrade-test', url: ':memory:' }),
});

function handle(): InterviewWorkflowHandle {
  return mastra.getWorkflow('regradeWorkflow') as unknown as InterviewWorkflowHandle;
}

const requestContext = buildModelRequestContext(resolveModelTiers({}));

const smallCaps = capLimitsSchema.parse({
  maxQuestions: 2,
  maxConsecutiveFollowUps: 2,
  maxReprompts: 1,
  tokenBudget: 1_000_000,
});

const seed = {
  profile: candidateProfileSchema.parse({ name: 'Ada Lovelace' }),
  roleContext: roleContextSchema.parse({ role: 'Staff Engineer' }),
  researchUrls: [],
  companyBrief: EMPTY_COMPANY_BRIEF,
  limits: smallCaps,
  targetLevel: 'senior',
};

/** Drive a fresh run to a finished report, returning its runId and report path. */
async function runToReport(): Promise<{ runId: string; reportPath: string }> {
  const run = await mastra.getWorkflow('regradeWorkflow').createRun();
  let result = await run.start({ inputData: seed, requestContext });
  while (result.status === 'suspended') {
    result = await run.resume({ resumeData: { answer: 'A concrete answer.' }, requestContext });
  }
  if (result.status !== 'success') {
    throw new Error(`expected a finished interview, got status ${result.status}`);
  }
  const state = reportedInterviewStateSchema.parse(result.result);
  return { runId: run.runId, reportPath: state.reportPath };
}

/** Drive a run until the injected fault terminates it, returning its runId. */
async function runToFailure(): Promise<string> {
  const run = await mastra.getWorkflow('regradeWorkflow').createRun();
  let result = await run.start({ inputData: seed, requestContext });
  while (result.status === 'suspended') {
    result = await run.resume({ resumeData: { answer: 'A concrete answer.' }, requestContext });
  }
  if (result.status !== 'failed') {
    throw new Error(`expected a failed interview, got status ${result.status}`);
  }
  return run.runId;
}

describe('regradeSession / recoachSession', () => {
  let cwd: string;
  let dir: string;

  beforeEach(async () => {
    failMode = 'none';
    brainCalls.decide = 0;
    brainCalls.question = 0;
    brainCalls.assess = 0;
    graderCalls.count = 0;
    coachCalls.count = 0;
    cwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'regrade-'));
    // The report step writes under `<cwd>/data/reports`; isolate it to a temp dir.
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  it('regrade re-runs grade+coach+report from the stored transcript with no interview turns', async () => {
    const { runId, reportPath } = await runToReport();
    expect(existsSync(reportPath)).toBe(true);
    expect(brainCalls.question).toBe(2);

    // Forget everything the first run did, then regrade purely by runId.
    brainCalls.decide = 0;
    brainCalls.question = 0;
    brainCalls.assess = 0;
    graderCalls.count = 0;
    coachCalls.count = 0;

    const outcome = await regradeSession({ workflow: handle(), runId, requestContext });

    expect(outcome.kind).toBe('replayed');
    if (outcome.kind !== 'replayed') return;
    expect(outcome.result.status).toBe('success');

    // No interview turn was re-executed — the transcript came straight from the snapshot.
    expect(brainCalls.decide).toBe(0);
    expect(brainCalls.question).toBe(0);
    expect(brainCalls.assess).toBe(0);
    // Grade and coach both re-ran, producing a fresh report on disk.
    expect(graderCalls.count).toBeGreaterThan(0);
    expect(coachCalls.count).toBeGreaterThan(0);
    const state = reportedInterviewStateSchema.parse(outcome.result.result);
    expect(existsSync(state.reportPath)).toBe(true);
  });

  it('recoach re-runs coaching only, reusing the stored grade, with no interview turns', async () => {
    const { runId } = await runToReport();

    brainCalls.decide = 0;
    brainCalls.question = 0;
    brainCalls.assess = 0;
    graderCalls.count = 0;
    coachCalls.count = 0;

    const outcome = await recoachSession({ workflow: handle(), runId, requestContext });

    expect(outcome.kind).toBe('replayed');
    if (outcome.kind !== 'replayed') return;
    expect(outcome.result.status).toBe('success');

    // No interview turns, and the grade was reused from the snapshot (grader not re-run),
    // while coaching re-ran to write a fresh report.
    expect(brainCalls.question).toBe(0);
    expect(graderCalls.count).toBe(0);
    expect(coachCalls.count).toBeGreaterThan(0);
    const state = reportedInterviewStateSchema.parse(outcome.result.result);
    expect(existsSync(state.reportPath)).toBe(true);
  });

  it('reports not-found when there is no run with that id', async () => {
    const outcome = await regradeSession({
      workflow: handle(),
      runId: 'does-not-exist',
      requestContext,
    });
    expect(outcome.kind).toBe('not-found');
  });

  it('reports unfinished when the interview is still suspended mid-session', async () => {
    const run = await mastra.getWorkflow('regradeWorkflow').createRun();
    const started = await run.start({ inputData: seed, requestContext });
    expect(started.status).toBe('suspended');

    const outcome = await recoachSession({ workflow: handle(), runId: run.runId, requestContext });
    expect(outcome.kind).toBe('unfinished');
  });

  it('reports not-replayable for regrade when the run failed before closing', async () => {
    failMode = 'loop';
    const runId = await runToFailure();

    // The run is terminal (failed) but never reached `closing`, so there is no stored
    // transcript to grade — regrade must refuse it rather than time-travel into nothing.
    const outcome = await regradeSession({ workflow: handle(), runId, requestContext });
    expect(outcome.kind).toBe('not-replayable');
  });

  it('reports not-replayable for recoach when the run failed at the grade step', async () => {
    failMode = 'grade';
    const runId = await runToFailure();

    // `closing` succeeded, but `grade` never did — so recoach has no stored grade to
    // reuse and must refuse rather than time-travel from `coach` into a missing grade.
    const outcome = await recoachSession({ workflow: handle(), runId, requestContext });
    expect(outcome.kind).toBe('not-replayable');
  });
});
