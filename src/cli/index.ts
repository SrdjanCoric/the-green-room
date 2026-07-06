#!/usr/bin/env node
import * as p from '@clack/prompts';
import { Command } from 'commander';

import {
  formatCandidateProfile,
  formatRoleContext,
  ingestCv,
  resolveJobPosting,
} from './run-interview';
import { runPing } from './run-ping';

const program = new Command();

program
  .name('interview-coach')
  .description('CLI for the agentic behavioral-interview coach.')
  .version('0.1.0')
  .argument('[message]', 'message for the ping workflow to echo')
  .action(async (message?: string) => {
    p.intro('interview-coach');

    let text = message;
    if (text === undefined) {
      const answer = await p.text({
        message: 'Message for the ping workflow to echo?',
        placeholder: 'hello',
        defaultValue: 'hello',
      });
      if (p.isCancel(answer)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      text = answer;
    }

    const spinner = p.spinner();
    spinner.start('Running ping workflow…');
    try {
      const echoed = await runPing(text);
      spinner.stop('Workflow finished.');
      p.outro(`Echoed: ${echoed}`);
    } catch (error) {
      spinner.stop('Workflow failed.');
      p.cancel(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command('interview')
  .description('Ingest a CV and a job posting into a candidate profile and role context.')
  .requiredOption('--cv <path>', 'path to the candidate CV (.pdf, .txt, or .md)')
  .option('--job <url|file|text>', 'job posting as a URL, a file path, or pasted text')
  .option('--provider <name>', 'model provider for both tiers (default: anthropic)')
  .option('--fast-model <id>', 'model id for the fast tier (CV/role parsers, interviewer)')
  .option('--smart-model <id>', 'model id for the smart tier (director, grader, coach)')
  .option('--candidate <id>', 'stable candidate id; keys resource-scoped memory')
  .action(
    async (options: {
      cv: string;
      job?: string;
      provider?: string;
      fastModel?: string;
      smartModel?: string;
      candidate?: string;
    }) => {
      p.intro('interview-coach');

      let postingText: string | undefined;
      if (options.job) {
        try {
          postingText = await resolveJobPosting({
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
        } catch (error) {
          p.cancel(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
          return;
        }
      }

      const spinner = p.spinner();
      spinner.start(postingText ? 'Parsing CV and job posting…' : 'Parsing CV…');
      try {
        const { profile, roleContext } = await ingestCv({
          cvPath: options.cv,
          postingText,
          provider: options.provider,
          fastModel: options.fastModel,
          smartModel: options.smartModel,
          resourceId: options.candidate,
        });
        spinner.stop('Parsed.');
        p.note(formatCandidateProfile(profile), 'Candidate profile');
        p.note(formatRoleContext(roleContext), 'Role context');
        p.outro('Profile saved to working memory.');
      } catch (error) {
        spinner.stop('Parsing failed.');
        p.cancel(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    },
  );

// Catch rejections that fall outside the action's own try/catch — e.g. an
// interactive prompt failing when there is no TTY — so the CLI exits cleanly
// instead of crashing with an unhandled rejection.
program.parseAsync().catch((error) => {
  p.cancel(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
