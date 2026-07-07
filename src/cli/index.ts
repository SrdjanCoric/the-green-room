import * as p from '@clack/prompts';

import { describeError } from '../mastra/errors';
import { mastra } from '../mastra/index';
import { listReports } from '../mastra/reporting';
import {
  loadLastRun,
  reconnectInterview,
  recoachSession,
  regradeSession,
  runInterview,
  type InterviewWorkflowHandle,
} from '../mastra/session/interview-session';
import { buildProgram } from './program';

// The CLI operator supplies their own trusted CV path, so opt this process out of the
// upload-directory confinement the interview workflow applies to client-supplied paths
// over the Mastra server. `mastra dev` never sets this, so browser runs stay confined.
process.env.INTERVIEW_COACH_TRUST_LOCAL_CV ??= '1';

const program = buildProgram({
  workflow: () => mastra.getWorkflow('interviewWorkflow') as InterviewWorkflowHandle,
  runInterview,
  reconnectInterview,
  regradeSession,
  recoachSession,
  loadLastRun,
  listReports,
});

// Catch rejections that fall outside the action's own try/catch — e.g. an
// interactive prompt failing when there is no TTY — so the CLI exits cleanly
// instead of crashing with an unhandled rejection.
program.parseAsync().catch((error: unknown) => {
  p.cancel(describeError(error));
  process.exitCode = 1;
});
