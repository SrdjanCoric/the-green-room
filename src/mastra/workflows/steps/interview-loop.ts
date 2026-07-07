import { createStep } from '@mastra/core/workflows';

import {
  DEFAULT_CAP_LIMITS,
  INITIAL_COVERAGE,
  allowQuestion,
} from '../../interview/interview-caps';
import {
  advanceCoverage,
  agentBrainFactory,
  decideNextMove,
  type BrainFactory,
} from '../../interview/adaptive-brain';
import {
  answerResumeSchema,
  closedInterviewStateSchema,
  interviewComplete,
  interviewStateSchema,
  levelResumeSchema,
  levelSuspendSchema,
  questionSuspendSchema,
  researchOutputSchema,
  type InterviewState,
} from '../interview-state';

/**
 * `collectLevel`: resolve the target seniority level. If it arrived on the run input
 * (the `--level` flag) it passes straight through; otherwise the step suspends to ask
 * for it, and resumes with the operator's answer. Either way it seeds the interview
 * loop state — an empty transcript, zeroed coverage, and the default caps.
 */
export const collectLevelStep = createStep({
  id: 'collectLevel',
  inputSchema: researchOutputSchema,
  outputSchema: interviewStateSchema,
  suspendSchema: levelSuspendSchema,
  resumeSchema: levelResumeSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    const provided = inputData.targetLevel?.trim();
    const resumed = resumeData?.level?.trim();
    const level = provided && provided.length > 0 ? provided : resumed;

    if (!level) {
      return await suspend({
        kind: 'level',
        prompt: 'What seniority level should this interview target? (e.g. junior, senior, staff)',
      });
    }

    return {
      ...inputData,
      targetLevel: level,
      transcript: [],
      assessments: [],
      currentTopic: '',
      coverage: INITIAL_COVERAGE,
      limits: inputData.limits ?? DEFAULT_CAP_LIMITS,
      done: false,
    };
  },
});

/**
 * Build the adaptive interview-turn step around a brain factory. The factory resolves the
 * director, interviewer, and assessor from the run's Mastra registry; production passes
 * `agentBrainFactory`, and tests pass a fake so the loop mechanics can run without models.
 *
 * One turn works in two passes:
 *  - **Fresh pass** (no resume data): if the session-ending caps are already spent, end
 *    without asking. Otherwise the director decides the next move (nudged past any spent
 *    per-topic avenue); a `wrap_up`/`terminate` ends the loop, and any other move is
 *    rendered into a question by the interviewer and suspended on, along with the move
 *    that produced it.
 *  - **Resume pass** (answer arrives): record the exact question and answer, advance the
 *    coverage counters and current topic for that move, run the assessor over the updated
 *    transcript, append its read to the assessment log, and mark the loop done once the
 *    caps are spent. The question is read back from the suspend data — never regenerated —
 *    so an adaptive question can only differ from what the candidate actually answered by
 *    being a hard error, not a silent mismatch.
 */
export function createInterviewTurnStep(makeBrain: BrainFactory) {
  return createStep({
    id: 'interviewTurn',
    inputSchema: interviewStateSchema,
    outputSchema: interviewStateSchema,
    suspendSchema: questionSuspendSchema,
    resumeSchema: answerResumeSchema,
    execute: async ({ inputData, resumeData, suspend, suspendData, mastra, requestContext }) => {
      const brain = makeBrain(mastra, requestContext);

      if (!resumeData) {
        // Defense-in-depth: on the normal path `done` already gates the loop, so a fresh
        // pass is only reached with caps to spare. But this enforces the architectural
        // invariant that the caps end the session regardless of the director — if the step
        // is ever entered fresh with spent caps (a re-entered or externally seeded run), we
        // stop here rather than consult the director and risk a question past the cap.
        if (interviewComplete(inputData)) {
          return { ...inputData, done: true };
        }

        const decision = await decideNextMove({
          coverage: inputData.coverage,
          limits: inputData.limits,
          decide: (nudge) => brain.decide(inputData, nudge),
        });
        if (decision.action === 'wrap_up' || decision.action === 'terminate') {
          return { ...inputData, done: true };
        }

        const question = await brain.question(inputData, decision);
        return await suspend({
          kind: 'question',
          question,
          questionNumber: inputData.coverage.questionCount + 1,
          action: decision.action,
          subject: decision.subject,
        });
      }

      if (!suspendData?.question) {
        throw new Error(
          'Interview turn resumed without its suspended question; cannot record the transcript.',
        );
      }

      const entry = { question: suspendData.question, answer: resumeData.answer };
      const transcript = [...inputData.transcript, entry];
      const { coverage, currentTopic } = advanceCoverage(
        { coverage: inputData.coverage, currentTopic: inputData.currentTopic },
        { action: suspendData.action, subject: suspendData.subject },
        entry,
      );
      const assessment = await brain.assess(currentTopic, transcript);

      return {
        ...inputData,
        transcript,
        assessments: [...inputData.assessments, { topic: currentTopic, assessment }],
        currentTopic,
        coverage,
        done: !allowQuestion(coverage, inputData.limits, 'new').allowed,
      };
    },
  });
}

/** The production interview-turn step, driven by the three real interview agents. */
export const interviewTurnStep = createInterviewTurnStep(agentBrainFactory);

/** The `.dountil` condition: stop looping once a turn reports the caps are spent. */
export async function interviewLoopDone({
  inputData,
}: {
  inputData: InterviewState;
}): Promise<boolean> {
  return inputData.done === true;
}

export const closingStep = createStep({
  id: 'closing',
  inputSchema: interviewStateSchema,
  outputSchema: closedInterviewStateSchema,
  execute: async ({ inputData }) => ({
    ...inputData,
    closingMessage:
      inputData.transcript.length > 0
        ? 'That covers what I wanted to ask. Thanks for walking me through it today.'
        : 'That covers what I wanted to ask today. Thanks for your time.',
  }),
});
