import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CAP_LIMITS } from '../mastra/interview/interview-caps';
import { candidateProfileSchema } from '../mastra/schemas/candidate-profile';
import { coachReportSchema, sessionGradeSchema } from '../mastra/schemas/coach-report';
import { EMPTY_COMPANY_BRIEF } from '../mastra/schemas/company-brief';
import { roleContextSchema } from '../mastra/schemas/role-context';
import { reportedInterviewStateSchema } from '../mastra/workflows/interview-state';
import type { InterviewWorkflowHandle } from '../mastra/session/interview-session';
import { buildProgram, type CliDeps } from './program';

// A finished-interview state that satisfies the report schema, so the happy-path
// actions can print their closing summary from a fake runner's result.
const reportedState = reportedInterviewStateSchema.parse({
  profile: candidateProfileSchema.parse({ name: 'Ada Lovelace' }),
  roleContext: roleContextSchema.parse({ role: 'Staff Engineer' }),
  candidateId: 'candidate-cli-test',
  candidateIdOrigin: 'default',
  threadId: 'thread-cli-test',
  researchUrls: [],
  companyBrief: EMPTY_COMPANY_BRIEF,
  limits: DEFAULT_CAP_LIMITS,
  targetLevel: 'senior',
  coverage: {},
  done: true,
  closingMessage: 'Thanks for your time.',
  grade: sessionGradeSchema.parse({ scores: [], skipped: [] }),
  coaching: coachReportSchema.parse({ summary: '', answerAdvice: [], drills: [], studyPlan: '' }),
  reportPath: '/tmp/report.md',
  reportGeneratedAt: '2026-07-07T09:00:00.000Z',
});

/** Deps where every runner fails loudly unless a test injects its own. */
function unwiredDeps(): CliDeps {
  const unwired = (name: string) => () => {
    throw new Error(`${name} should not have been called by this command`);
  };
  return {
    workflow: () => ({}) as InterviewWorkflowHandle,
    runInterview: unwired('runInterview'),
    reconnectInterview: unwired('reconnectInterview'),
    regradeSession: unwired('regradeSession'),
    recoachSession: unwired('recoachSession'),
    loadLastRun: unwired('loadLastRun'),
    listReports: unwired('listReports'),
  };
}

async function parse(deps: CliDeps, args: string[]): Promise<void> {
  await buildProgram(deps).parseAsync(args, { from: 'user' });
}

describe('buildProgram', () => {
  beforeEach(() => {
    // The actions narrate through the terminal UI; keep that out of the test output.
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers the interview, resume, regrade, recoach, and reports commands', () => {
    const program = buildProgram(unwiredDeps());
    const names = program.commands.map((command) => command.name());
    expect(names).toEqual(['interview', 'resume', 'regrade', 'recoach', 'reports']);
  });

  it('wires --cv, --level, and --max-questions into the interview run input', async () => {
    const runInterview = vi.fn(
      async (): Promise<{ runId: string; result: { status: 'success'; result: unknown } }> => ({
        runId: 'run-1',
        result: { status: 'success', result: reportedState },
      }),
    );
    await parse({ ...unwiredDeps(), runInterview }, [
      'interview',
      '--cv',
      'cv.md',
      '--level',
      'staff',
      '--max-questions',
      '3',
    ]);

    expect(runInterview).toHaveBeenCalledTimes(1);
    const params = runInterview.mock.calls[0] as unknown as [
      { inputData: { cvPath: string; targetLevel?: string; limits?: { maxQuestions: number } } },
    ];
    expect(params[0].inputData.cvPath).toBe('cv.md');
    expect(params[0].inputData.targetLevel).toBe('staff');
    // The flag raises only the question cap; the other caps keep their defaults.
    expect(params[0].inputData.limits).toEqual({ ...DEFAULT_CAP_LIMITS, maxQuestions: 3 });
  });

  it('leaves the caps unset when --max-questions is not given', async () => {
    const runInterview = vi.fn(
      async (): Promise<{ runId: string; result: { status: 'success'; result: unknown } }> => ({
        runId: 'run-1',
        result: { status: 'success', result: reportedState },
      }),
    );
    await parse({ ...unwiredDeps(), runInterview }, ['interview', '--cv', 'cv.md']);

    const params = runInterview.mock.calls[0] as unknown as [
      { inputData: { limits?: unknown } },
    ];
    expect(params[0].inputData.limits).toBeUndefined();
  });

  it('rejects a non-positive --max-questions at parse time, before any run starts', async () => {
    const program = buildProgram(unwiredDeps()).exitOverride();
    program.configureOutput({ writeErr: () => undefined });
    for (const command of program.commands) {
      command.exitOverride();
      command.configureOutput({ writeErr: () => undefined });
    }

    await expect(
      program.parseAsync(['interview', '--cv', 'cv.md', '--max-questions', '0'], {
        from: 'user',
      }),
    ).rejects.toThrow(/positive whole number/i);
  });

  it('resume falls back to the stored last run when no --run is given', async () => {
    const loadLastRun = vi.fn(async () => ({ runId: 'run-9', threadId: 'thread-9' }));
    const reconnectInterview = vi.fn(
      async (): Promise<{
        kind: 'already-finished';
        result: { status: 'success'; result: unknown };
      }> => ({ kind: 'already-finished', result: { status: 'success', result: reportedState } }),
    );
    await parse({ ...unwiredDeps(), loadLastRun, reconnectInterview }, ['resume']);

    expect(reconnectInterview).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-9' }));
  });

  it('regrade passes the explicit session id through to the replay runner', async () => {
    const regradeSession = vi.fn(
      async (): Promise<{
        kind: 'replayed';
        result: { status: 'success'; result: unknown };
      }> => ({ kind: 'replayed', result: { status: 'success', result: reportedState } }),
    );
    await parse({ ...unwiredDeps(), regradeSession }, ['regrade', 'run-42']);

    expect(regradeSession).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-42' }));
  });

  it('reports lists the saved reports through the injected reader', async () => {
    const listReports = vi.fn(async () => []);
    await parse({ ...unwiredDeps(), listReports }, ['reports']);

    expect(listReports).toHaveBeenCalledTimes(1);
  });
});
