#!/usr/bin/env node
import * as p from '@clack/prompts';
import { Command } from 'commander';

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

// Catch rejections that fall outside the action's own try/catch — e.g. an
// interactive prompt failing when there is no TTY — so the CLI exits cleanly
// instead of crashing with an unhandled rejection.
program.parseAsync().catch((error) => {
  p.cancel(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
