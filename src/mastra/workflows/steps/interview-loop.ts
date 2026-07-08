import { createStep } from '@mastra/core/workflows';

import {
  DEFAULT_CAP_LIMITS,
  INITIAL_COVERAGE,
  allowQuestion,
} from '../../interview/interview-caps';
import {
  advanceCoverage,
  agentBrainFactory,
  agentClosingFactory,
  decideNextMove,
  type BrainFactory,
  type ClosingFactory,
} from '../../interview/adaptive-brain';
import { describeError } from '../../errors';
import {
  closedInterviewStateSchema,
  interviewComplete,
  interviewStateSchema,
  levelResumeSchema,
  levelSuspendSchema,
  researchOutputSchema,
  turnResumeSchema,
  turnSuspendSchema,
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
        prompt: 'What seniority level should this interview target?',
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

/** One answered turn, complete enough to record and assess (or replay after a failure). */
interface AnsweredTurn {
  question: string;
  questionNumber: number;
  action: Parameters<typeof advanceCoverage>[1]['action'];
  subject: string;
  answer: string;
}

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
 *
 * An agent failure that survives structuredCall's bounded retries does not fail the run:
 * the step suspends with a `kind: 'failure'` payload instead, keeping the transcript safe
 * in the snapshot, and a `{ retry: true }` resume retries the turn. A failure on the
 * resume pass carries the answered turn in the payload, so the retry replays it — assess
 * only — and the candidate is never re-asked a question they already answered.
 */
export function createInterviewTurnStep(makeBrain: BrainFactory) {
  return createStep({
    id: 'interviewTurn',
    inputSchema: interviewStateSchema,
    outputSchema: interviewStateSchema,
    suspendSchema: turnSuspendSchema,
    resumeSchema: turnResumeSchema,
    execute: async ({ inputData, resumeData, suspend, suspendData, mastra, requestContext, writer }) => {
      // The step's writer forwards the interviewer's token chunks into the run stream,
      // so a client watching over SSE sees the question typed out live.
      const brain = makeBrain(mastra, requestContext, writer);

      /** Record an answered turn, assess it, and advance the loop state. */
      const completeTurn = async (turn: AnsweredTurn) => {
        const entry = { question: turn.question, answer: turn.answer };
        const transcript = [...inputData.transcript, entry];
        const { coverage, currentTopic } = advanceCoverage(
          { coverage: inputData.coverage, currentTopic: inputData.currentTopic },
          { action: turn.action, subject: turn.subject },
          entry,
        );
        let assessment;
        try {
          assessment = await brain.assess(currentTopic, transcript);
        } catch (error) {
          // The answer is already in hand — carry the whole turn so the retry replays
          // it without re-asking.
          return await suspend({
            kind: 'failure',
            stage: 'assessor',
            reason: `The assessor failed: ${describeError(error)}`,
            pending: turn,
          });
        }

        return {
          ...inputData,
          transcript,
          assessments: [...inputData.assessments, { topic: currentTopic, assessment }],
          currentTopic,
          coverage,
          done: !allowQuestion(coverage, inputData.limits, 'new').allowed,
        };
      };

      const retrying = resumeData !== undefined && 'retry' in resumeData;
      const failure = suspendData?.kind === 'failure' ? suspendData : undefined;

      // Retry of a resume-pass failure: the answered turn rode the failure payload.
      if (retrying && failure?.pending) {
        return await completeTurn(failure.pending);
      }

      if (!resumeData || retrying) {
        // Fresh pass (or the retry of a fresh-pass failure, which re-runs it whole).
        // Defense-in-depth: on the normal path `done` already gates the loop, so a fresh
        // pass is only reached with caps to spare. But this enforces the architectural
        // invariant that the caps end the session regardless of the director — if the step
        // is ever entered fresh with spent caps (a re-entered or externally seeded run), we
        // stop here rather than consult the director and risk a question past the cap.
        if (interviewComplete(inputData)) {
          return { ...inputData, done: true };
        }

        let decision;
        try {
          decision = await decideNextMove({
            coverage: inputData.coverage,
            limits: inputData.limits,
            decide: (nudge) => brain.decide(inputData, nudge),
          });
        } catch (error) {
          return await suspend({
            kind: 'failure',
            stage: 'director',
            reason: `The director failed: ${describeError(error)}`,
          });
        }
        if (decision.action === 'wrap_up' || decision.action === 'terminate') {
          return { ...inputData, done: true };
        }

        let question;
        try {
          question = await brain.question(inputData, decision);
        } catch (error) {
          return await suspend({
            kind: 'failure',
            stage: 'interviewer',
            reason: `The interviewer failed: ${describeError(error)}`,
          });
        }
        return await suspend({
          kind: 'question',
          question,
          questionNumber: inputData.coverage.questionCount + 1,
          action: decision.action,
          subject: decision.subject,
        });
      }

      if (suspendData?.kind !== 'question' || !suspendData.question) {
        throw new Error(
          'Interview turn resumed without its suspended question; cannot record the transcript.',
        );
      }

      return await completeTurn({
        question: suspendData.question,
        questionNumber: suspendData.questionNumber,
        action: suspendData.action,
        subject: suspendData.subject,
        answer: resumeData.answer,
      });
    },
  });
}

/** The production interview-turn step, driven by the three real interview agents. */
export const interviewTurnStep = createInterviewTurnStep(agentBrainFactory);

/** The `.dountil` condition: stop looping once a turn reports the caps are spent. */
export function interviewLoopDone({
  inputData,
}: {
  inputData: InterviewState;
}): Promise<boolean> {
  return Promise.resolve(inputData.done === true);
}

/** The closing lines used when there is nothing to say goodbye over, or the agent fails. */
function staticClosing(state: InterviewState): string {
  return state.transcript.length > 0
    ? 'That covers what I wanted to ask. Thanks for walking me through it today.'
    : 'That covers what I wanted to ask today. Thanks for your time.';
}

/**
 * Build the closing step around a closing factory. The interviewer says goodbye in its
 * own words, written fresh over the finished transcript and streamed through the step's
 * writer so the client sees it typed out before grading begins. The closing must never
 * strand a finished transcript: an agent failure that survives the bounded retries
 * degrades to the static line, and an empty transcript (the director wrapped up before
 * asking anything) skips the agent entirely — there is nothing to recall.
 */
export function createClosingStep(makeClosing: ClosingFactory) {
  return createStep({
    id: 'closing',
    inputSchema: interviewStateSchema,
    outputSchema: closedInterviewStateSchema,
    execute: async ({ inputData, mastra, requestContext, writer }) => {
      const fallback = staticClosing(inputData);
      if (inputData.transcript.length > 0) {
        try {
          const closingMessage = await makeClosing(mastra, requestContext, writer)(inputData);
          return { ...inputData, closingMessage };
        } catch {
          // The fallback below stands; grading matters more than the goodbye.
        }
      }
      // The agent was skipped or failed — possibly after streaming a partial goodbye.
      // Put the static line on the run stream too, so a watching client converges on
      // the same closing the run records instead of keeping truncated text.
      await writer.write({ type: 'text-start', payload: {} });
      await writer.write({ type: 'text-delta', payload: { text: fallback } });
      return { ...inputData, closingMessage: fallback };
    },
  });
}

/** The production closing step, spoken by the interviewer agent. */
export const closingStep = createClosingStep(agentClosingFactory);
