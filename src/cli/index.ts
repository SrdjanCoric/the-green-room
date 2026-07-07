#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

import * as p from '@clack/prompts';
import { Command, InvalidArgumentError } from 'commander';

import { mastra } from '../mastra/index';
import { limitsWithMaxQuestions } from '../mastra/interview/interview-caps';
import { buildModelRequestContext, resolveModelTiers } from '../mastra/model-config';
import { reportedInterviewStateSchema } from '../mastra/workflows/interview-state';
import {
  describeDriveFailure,
  loadLastRun,
  reconnectInterview,
  readMultilineAnswer,
  recoachSession,
  regradeSession,
  runInterview,
  type InterviewWorkflowHandle,
  type ReplayOutcome,
  type ReplaySessionParams,
} from './interview-session';
import { listReports } from './reports';
import {
  formatCompanyBrief,
  formatRoleContext,
  formatTranscript,
  resolveJobPosting,
} from './run-interview';

// The CLI operator supplies their own trusted CV path, so opt this process out of the
// upload-directory confinement the interview workflow applies to client-supplied paths
// over the Mastra server. `mastra dev` never sets this, so browser runs stay confined.
process.env.INTERVIEW_COACH_TRUST_LOCAL_CV ??= '1';

const program = new Command();

/** Parse a commander option value that must be a positive integer. */
function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Expected a positive whole number.');
  }
  return parsed;
}

/** The interview workflow, typed for the session runners. */
function interviewWorkflow(): InterviewWorkflowHandle {
  return mastra.getWorkflow('interviewWorkflow') as InterviewWorkflowHandle;
}

/**
 * Terminal prompt callbacks shared by the `interview` and `resume` commands: a single
 * line for the target level, and a multi-line answer (ended with `/done`) per question.
 */
function terminalPrompts(): {
  onLevel: (prompt: string) => Promise<string>;
  onQuestion: (question: string, questionNumber: number) => Promise<string>;
} {
  return {
    onLevel: async (prompt) => {
      const answer = await p.text({ message: prompt, placeholder: 'senior' });
      if (p.isCancel(answer)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      return String(answer).trim() || 'senior';
    },
    onQuestion: async (question, questionNumber) => {
      p.log.step(`Question ${questionNumber}`);
      process.stdout.write(`${question}\n\n(Type your answer; end with a line containing only /done.)\n`);
      return readMultilineAnswer();
    },
  };
}

/** Print the closing summary of a finished interview: role, company, and transcript. */
const CANDIDATE_ORIGIN_LABELS: Record<string, string> = {
  flag: 'from --candidate',
  cv: 'from CV',
  default: 'fallback',
};

function reportInterview(rawState: unknown): void {
  const state = reportedInterviewStateSchema.parse(rawState);
  p.note(
    `${state.candidateId} (${CANDIDATE_ORIGIN_LABELS[state.candidateIdOrigin] ?? state.candidateIdOrigin})`,
    'Candidate',
  );
  p.note(state.closingMessage, 'Closing');
  p.note(state.reportPath, 'Report');
  p.note(formatRoleContext(state.roleContext), 'Role context');
  p.note(formatCompanyBrief(state.companyBrief), 'Company brief');
  p.note(formatTranscript(state.transcript), `Transcript · level: ${state.targetLevel}`);
}

program
  .name('interview-coach')
  .description('CLI for the agentic behavioral-interview coach.')
  .version('0.1.0');

// `interview` is the default command, so a bare invocation runs the interview flow.
program
  .command('interview', { isDefault: true })
  .description('Run a behavioral interview against a CV and (optional) job posting.')
  .requiredOption('--cv <path>', 'path to the candidate CV (.pdf, .txt, or .md)')
  .option('--job <url|file|text>', 'job posting as a URL, a file path, or pasted text')
  .option('--level <level>', 'target seniority level; omit to be asked (e.g. junior, senior, staff)')
  .option('--provider <name>', 'model provider for both tiers (default: anthropic)')
  .option('--fast-model <id>', 'model id for the fast tier (CV/role parsers, interviewer)')
  .option('--smart-model <id>', 'model id for the smart tier (director, grader, coach)')
  .option(
    '--candidate <id>',
    'stable candidate id; defaults to the first email in the CV, then "default"',
  )
  .option(
    '--max-questions <count>',
    'ceiling on the number of questions asked in the session (default: 6)',
    parsePositiveInt,
  )
  .action(
    async (options: {
      cv: string;
      job?: string;
      level?: string;
      provider?: string;
      fastModel?: string;
      smartModel?: string;
      candidate?: string;
      maxQuestions?: number;
    }) => {
      p.intro('interview-coach');

      let postingText: string | undefined;
      let researchUrls: string[] = [];
      if (options.job) {
        try {
          const resolvedJob = await resolveJobPosting({
            job: options.job,
            // On a fetch failure, drop to a paste prompt so a broken link never blocks
            // the interview; a blank paste proceeds with a generic interview.
            onFetchFailure: async (url) => {
              p.log.warn(`Couldn't fetch the posting at ${url}.`);
              const pasted = await p.text({
                message: 'Paste the job posting text (leave blank to skip):',
              });
              if (p.isCancel(pasted)) return null;
              return pasted;
            },
          });
          postingText = resolvedJob.postingText;
          researchUrls = resolvedJob.researchUrls;
        } catch (error) {
          p.cancel(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
          return;
        }
      }

      const requestContext = buildModelRequestContext(resolveModelTiers(options));
      const threadId = randomUUID();

      const spinner = p.spinner();
      let preparing = false;
      const stopSpinner = (message: string) => {
        if (preparing) {
          spinner.stop(message);
          preparing = false;
        }
      };
      try {
        spinner.start(postingText ? 'Preparing interview from CV and posting…' : 'Preparing interview from CV…');
        preparing = true;
        const { runId, result } = await runInterview({
          workflow: interviewWorkflow(),
          inputData: {
            cvPath: options.cv,
            candidate: options.candidate,
            threadId,
            postingText,
            researchUrls,
            targetLevel: options.level,
            limits: limitsWithMaxQuestions(options.maxQuestions),
          },
          requestContext,
          threadId,
          // Stop the spinner the moment preparation is done and the first prompt is
          // about to appear, so it doesn't animate over the interactive questions.
          onReady: () => stopSpinner('Ready — starting the interview.'),
          ...terminalPrompts(),
        });

        const failure = describeDriveFailure(result);
        // Safety net for the paths where onReady never fired (preparation failed, or
        // the run finished without suspending): a no-op if the spinner is already down.
        stopSpinner(failure ? 'Preparation failed.' : 'Prepared.');
        if (failure) {
          p.cancel(failure);
          process.exitCode = 1;
          return;
        }

        reportInterview(result.result);
        p.outro(`Interview ${runId} finished. Resume anytime with \`resume\`.`);
      } catch (error) {
        stopSpinner('Preparation failed.');
        p.cancel(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    },
  );

program
  .command('resume')
  .description('Resume an interrupted interview from its stored run id.')
  .option('--run <id>', 'run id to resume (defaults to the most recent interview)')
  .action(async (options: { run?: string }) => {
    p.intro('interview-coach');

    const runId = options.run ?? (await loadLastRun())?.runId;
    if (!runId) {
      p.cancel('No interview to resume — start one with `interview` first.');
      process.exitCode = 1;
      return;
    }

    try {
      const outcome = await reconnectInterview({
        workflow: interviewWorkflow(),
        runId,
        ...terminalPrompts(),
      });

      if (outcome.kind === 'not-found') {
        p.cancel(`No interview run found for id ${runId}.`);
        process.exitCode = 1;
        return;
      }
      if (outcome.kind === 'already-finished') {
        p.outro(`Interview ${runId} has already finished — nothing to resume.`);
        return;
      }

      const failure = describeDriveFailure(outcome.result);
      if (failure) {
        p.cancel(failure);
        process.exitCode = 1;
        return;
      }

      reportInterview(outcome.result.result);
      p.outro(`Interview ${runId} finished.`);
    } catch (error) {
      p.cancel(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

/** Model-tier flags shared by the `regrade`/`recoach` commands. */
interface ReplayOptions {
  provider?: string;
  fastModel?: string;
  smartModel?: string;
}

/**
 * Shared action for `regrade`/`recoach`: resolve the run id (falling back to the most
 * recent interview), build the model context, replay the grading phase via the given
 * runner, and report the fresh result — mapping a missing or still-running interview to
 * a clear message.
 */
async function replayReport(
  runner: (params: ReplaySessionParams) => Promise<ReplayOutcome>,
  session: string | undefined,
  options: ReplayOptions,
  labels: { verb: string; gerund: string; done: string },
): Promise<void> {
  p.intro('interview-coach');

  const runId = session ?? (await loadLastRun())?.runId;
  if (!runId) {
    p.cancel(`No interview to ${labels.verb} — run one with \`interview\` first.`);
    process.exitCode = 1;
    return;
  }

  try {
    const requestContext = buildModelRequestContext(resolveModelTiers(options));
    const outcome = await runner({ workflow: interviewWorkflow(), runId, requestContext });

    if (outcome.kind === 'not-found') {
      p.cancel(`No interview run found for id ${runId}.`);
      process.exitCode = 1;
      return;
    }
    if (outcome.kind === 'unfinished') {
      p.cancel(`Interview ${runId} hasn't finished yet — resume it before ${labels.gerund}.`);
      process.exitCode = 1;
      return;
    }
    if (outcome.kind === 'not-replayable') {
      p.cancel(`Interview ${runId} didn't produce a gradeable session — nothing to ${labels.verb}.`);
      process.exitCode = 1;
      return;
    }

    const failure = describeDriveFailure(outcome.result);
    if (failure) {
      p.cancel(failure);
      process.exitCode = 1;
      return;
    }

    reportInterview(outcome.result.result);
    p.outro(`${labels.done} interview ${runId} — fresh report written.`);
  } catch (error) {
    p.cancel(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

program
  .command('regrade')
  .description('Re-grade a finished interview from its stored transcript, then re-coach and re-report.')
  .argument('[session]', 'run id to re-grade (defaults to the most recent interview)')
  .option('--provider <name>', 'model provider for both tiers (default: anthropic)')
  .option('--fast-model <id>', 'model id for the fast tier')
  .option('--smart-model <id>', 'model id for the smart tier (grader, coach)')
  .action((session: string | undefined, options: ReplayOptions) =>
    replayReport(regradeSession, session, options, {
      verb: 're-grade',
      gerund: 're-grading',
      done: 'Re-graded',
    }),
  );

program
  .command('recoach')
  .description('Re-coach a finished interview from its stored grade, then re-report.')
  .argument('[session]', 'run id to re-coach (defaults to the most recent interview)')
  .option('--provider <name>', 'model provider for both tiers (default: anthropic)')
  .option('--fast-model <id>', 'model id for the fast tier')
  .option('--smart-model <id>', 'model id for the smart tier (grader, coach)')
  .action((session: string | undefined, options: ReplayOptions) =>
    replayReport(recoachSession, session, options, {
      verb: 're-coach',
      gerund: 're-coaching',
      done: 'Re-coached',
    }),
  );

program
  .command('reports')
  .description('List saved Markdown coaching reports, newest first.')
  .action(async () => {
    p.intro('interview-coach');
    try {
      const reports = await listReports();
      if (reports.length === 0) {
        p.outro('No reports found.');
        return;
      }
      p.note(
        reports.map((report) => `${report.modifiedAt.toISOString()}  ${report.path}`).join('\n'),
        'Reports',
      );
      p.outro(`${reports.length} report${reports.length === 1 ? '' : 's'} found.`);
    } catch (error) {
      p.cancel(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

// Catch rejections that fall outside the action's own try/catch — e.g. an
// interactive prompt failing when there is no TTY — so the CLI exits cleanly
// instead of crashing with an unhandled rejection.
program.parseAsync().catch((error) => {
  p.cancel(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
