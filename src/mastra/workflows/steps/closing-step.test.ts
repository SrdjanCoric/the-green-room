import { describe, expect, it } from 'vitest';

import { Mastra } from '@mastra/core';
import { createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';

import { answerAssessmentSchema } from '../../schemas/answer-assessment';
import { candidateProfileSchema } from '../../schemas/candidate-profile';
import { EMPTY_COMPANY_BRIEF } from '../../schemas/company-brief';
import { directorDecisionSchema } from '../../schemas/director-decision';
import { roleContextSchema } from '../../schemas/role-context';
import type { BrainFactory, ClosingFactory } from '../../interview/adaptive-brain';
import { capLimitsSchema } from '../../interview/interview-caps';
import { closedInterviewStateSchema, researchOutputSchema } from '../interview-state';
import {
  collectLevelStep,
  createClosingStep,
  createInterviewTurnStep,
  interviewLoopDone,
} from './interview-loop';

// One-question caps so a single answered turn finishes the loop and reaches closing.
const oneQuestionCaps = capLimitsSchema.parse({
  maxQuestions: 1,
  maxConsecutiveFollowUps: 2,
  maxReprompts: 1,
  tokenBudget: 1_000_000,
});

const fakeBrainFactory: BrainFactory = () => ({
  decide: async () => directorDecisionSchema.parse({ action: 'new_topic', subject: 'a topic' }),
  question: async () => 'What led up to that?',
  assess: async () =>
    answerAssessmentSchema.parse({
      star: { situation: true, task: true, action: true, result: true, quantifiedResult: false },
      sufficientSignal: false,
    }),
});

// A brain that wraps up before asking anything, so closing runs over an empty transcript.
const wrapUpBrainFactory: BrainFactory = () => ({
  decide: async () => directorDecisionSchema.parse({ action: 'wrap_up' }),
  question: async () => {
    throw new Error('no question once wrapped up');
  },
  assess: async () => {
    throw new Error('no assessment once wrapped up');
  },
});

interface ClosingProbe {
  factory: ClosingFactory;
  seen: { sink: unknown; transcripts: unknown[]; calls: number };
}

/** A closing factory that records its wiring and speaks (or fails) on demand. */
function closingProbe(speak: () => Promise<string>): ClosingProbe {
  const seen: ClosingProbe['seen'] = { sink: undefined, transcripts: [], calls: 0 };
  const factory: ClosingFactory = (_registry, _requestContext, sink) => {
    seen.sink = sink;
    return async (state) => {
      seen.calls += 1;
      seen.transcripts.push(state.transcript);
      return speak();
    };
  };
  return { factory, seen };
}

const spoken = closingProbe(async () => 'Thanks for walking me through the migration.');
const failing = closingProbe(async () => {
  throw new Error('closing agent unavailable (simulated 429)');
});
const unasked = closingProbe(async () => {
  throw new Error('the closing agent must not be consulted for an empty transcript');
});

// The real level step seeds the loop state (the level is provided, so it never
// suspends), then the loop runs to its cap and the closing step under test follows.
function seededLoop(id: string, brain: BrainFactory, closing: ClosingFactory) {
  return createWorkflow({
    id,
    inputSchema: researchOutputSchema,
    outputSchema: closedInterviewStateSchema,
  })
    .then(collectLevelStep)
    .dountil(createInterviewTurnStep(brain), async (context) => interviewLoopDone(context))
    .then(createClosingStep(closing))
    .commit();
}

const failingStream = closingProbe(async () => {
  throw new Error('closing agent unavailable (simulated 429)');
});

const mastra = new Mastra({
  workflows: {
    spokenWorkflow: seededLoop('spokenWorkflow', fakeBrainFactory, spoken.factory),
    failingWorkflow: seededLoop('failingWorkflow', fakeBrainFactory, failing.factory),
    failingStreamWorkflow: seededLoop('failingStreamWorkflow', fakeBrainFactory, failingStream.factory),
    emptyWorkflow: seededLoop('emptyWorkflow', wrapUpBrainFactory, unasked.factory),
  },
  storage: new LibSQLStore({ id: 'closing-test', url: ':memory:' }),
});

function seed() {
  return {
    profile: candidateProfileSchema.parse({ name: 'Ada Lovelace' }),
    roleContext: roleContextSchema.parse({ role: 'Staff Engineer' }),
    candidateId: 'candidate-closing-test',
    candidateIdOrigin: 'default' as const,
    threadId: 'thread-closing-test',
    researchUrls: [],
    companyBrief: EMPTY_COMPANY_BRIEF,
    limits: oneQuestionCaps,
    targetLevel: 'senior',
  };
}

describe('the closing step', () => {
  it('speaks the closing through the agent over the finished transcript, wired to the step writer', async () => {
    const run = await mastra.getWorkflow('spokenWorkflow').createRun();
    let result = await run.start({ inputData: seed() });
    expect(result.status).toBe('suspended');
    result = await run.resume({ resumeData: { answer: 'I moved the API off the monolith.' } });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.result.closingMessage).toBe('Thanks for walking me through the migration.');
    // The factory received the step's writer so the goodbye streams into the run.
    expect(spoken.seen.sink).toBeDefined();
    expect(spoken.seen.transcripts[0]).toEqual([
      { question: 'What led up to that?', answer: 'I moved the API off the monolith.' },
    ]);
  });

  it('falls back to the static line when the closing agent fails, without failing the run', async () => {
    const run = await mastra.getWorkflow('failingWorkflow').createRun();
    let result = await run.start({ inputData: seed() });
    expect(result.status).toBe('suspended');
    result = await run.resume({ resumeData: { answer: 'I moved the API off the monolith.' } });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.result.closingMessage).toBe(
      'That covers what I wanted to ask. Thanks for walking me through it today.',
    );
    expect(failing.seen.calls).toBe(1);
  });

  it('streams the fallback line through the writer, so a watching client converges on it', async () => {
    // The agent can fail after streaming a partial goodbye; the step must then put
    // the static line on the run stream too, or the client keeps the truncated text.
    const run = await mastra.getWorkflow('failingStreamWorkflow').createRun();
    const started = await run.start({ inputData: seed() });
    expect(started.status).toBe('suspended');

    const output = run.resumeStream({ resumeData: { answer: 'I moved the API off the monolith.' } });
    const closingTexts: string[] = [];
    let sawClosingStart = false;
    for await (const chunk of output.fullStream) {
      if (typeof chunk !== 'object' || chunk === null) continue;
      const record = chunk as {
        type?: string;
        payload?: { stepName?: string; output?: { type?: string; payload?: { text?: string } } };
      };
      if (record.type !== 'workflow-step-output' || record.payload?.stepName !== 'closing') continue;
      if (record.payload.output?.type === 'text-start') sawClosingStart = true;
      if (record.payload.output?.type === 'text-delta' && record.payload.output.payload?.text) {
        closingTexts.push(record.payload.output.payload.text);
      }
    }
    const result = await output.result;

    expect(result.status).toBe('success');
    expect(sawClosingStart).toBe(true);
    expect(closingTexts.join('')).toBe(
      'That covers what I wanted to ask. Thanks for walking me through it today.',
    );
  });

  it('keeps the static line for an empty transcript and never consults the agent', async () => {
    const run = await mastra.getWorkflow('emptyWorkflow').createRun();
    const result = await run.start({ inputData: seed() });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.result.closingMessage).toBe(
      'That covers what I wanted to ask today. Thanks for your time.',
    );
    expect(unasked.seen.calls).toBe(0);
  });
});
