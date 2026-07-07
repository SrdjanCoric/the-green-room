import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Mastra } from '@mastra/core';
import { createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { candidateProfileSchema } from '../mastra/schemas/candidate-profile';
import { EMPTY_COMPANY_BRIEF } from '../mastra/schemas/company-brief';
import { roleContextSchema } from '../mastra/schemas/role-context';
import { capLimitsSchema } from '../mastra/workflows/interview-caps';
import {
  collectLevelStep,
  interviewLoopDone,
  interviewStateSchema,
  interviewTurnStep,
  researchOutputSchema,
} from '../mastra/workflows/interview-workflow';
import {
  loadLastRun,
  reconnectInterview,
  runInterview,
  type InterviewWorkflowHandle,
} from './interview-session';

// The real interview-loop steps on a real (in-memory) durable store, seeded past
// ingest/research so no models are called — the same durable path the CLI drives.
const loopWorkflow = createWorkflow({
  id: 'interviewSessionLoopTest',
  inputSchema: researchOutputSchema,
  outputSchema: interviewStateSchema,
})
  .then(collectLevelStep)
  .dountil(interviewTurnStep, async (context) => interviewLoopDone(context))
  .commit();

const mastra = new Mastra({
  workflows: { loopWorkflow },
  storage: new LibSQLStore({ id: 'session-test', url: ':memory:' }),
});

function handle(): InterviewWorkflowHandle {
  return mastra.getWorkflow('loopWorkflow') as InterviewWorkflowHandle;
}

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
};

describe('runInterview', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'interview-run-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('collects the level, drives every turn, and records the run pointer', async () => {
    const lastRunPath = join(dir, 'last-run.json');
    let questionNo = 0;

    const { runId, result } = await runInterview({
      workflow: handle(),
      inputData: seed,
      resourceId: 'cand-1',
      threadId: 'sess-1',
      onLevel: async () => 'senior',
      onQuestion: async () => `answer ${(questionNo += 1)}`,
      lastRunPath,
    });

    expect(result.status).toBe('success');
    const state = interviewStateSchema.parse(result.result);
    expect(state.transcript.map((entry) => entry.answer)).toEqual(['answer 1', 'answer 2']);
    expect(state.targetLevel).toBe('senior');

    // The pointer is on disk so `resume` could reconnect to this run.
    expect(await loadLastRun(lastRunPath)).toEqual({
      runId,
      resourceId: 'cand-1',
      threadId: 'sess-1',
    });
  });
});

describe('reconnectInterview', () => {
  it('resumes a mid-interview run by runId with the transcript intact', async () => {
    // Start and answer the first turn, then abandon the run object entirely.
    const run = await mastra.getWorkflow('loopWorkflow').createRun();
    const started = await run.start({ inputData: { ...seed, targetLevel: 'senior' } });
    if (started.status !== 'suspended') throw new Error('expected first suspension');
    const midway = await run.resume({ resumeData: { answer: 'answer before quitting' } });
    if (midway.status !== 'suspended') throw new Error('expected second suspension');
    const runId = run.runId;

    // Reconnect purely by runId, as the `resume` command does.
    const outcome = await reconnectInterview({
      workflow: handle(),
      runId,
      onLevel: async () => 'unused',
      onQuestion: async () => 'answer after resuming',
    });

    expect(outcome.kind).toBe('resumed');
    if (outcome.kind !== 'resumed') return;
    expect(outcome.result.status).toBe('success');
    const state = interviewStateSchema.parse(outcome.result.result);
    expect(state.transcript.map((entry) => entry.answer)).toEqual([
      'answer before quitting',
      'answer after resuming',
    ]);
  });

  it('reports nothing to resume when the run has already finished', async () => {
    // Drive a run to completion, then try to reconnect to it.
    const run = await mastra.getWorkflow('loopWorkflow').createRun();
    let result = await run.start({ inputData: { ...seed, targetLevel: 'senior' } });
    while (result.status === 'suspended') {
      result = await run.resume({ resumeData: { answer: 'done' } });
    }
    expect(result.status).toBe('success');

    const outcome = await reconnectInterview({
      workflow: handle(),
      runId: run.runId,
      onLevel: async () => 'x',
      onQuestion: async () => 'x',
    });

    expect(outcome.kind).toBe('already-finished');
  });

  it('reports not-found when there is no run with that id', async () => {
    const outcome = await reconnectInterview({
      workflow: handle(),
      runId: 'does-not-exist',
      onLevel: async () => 'x',
      onQuestion: async () => 'x',
    });

    expect(outcome.kind).toBe('not-found');
  });
});
