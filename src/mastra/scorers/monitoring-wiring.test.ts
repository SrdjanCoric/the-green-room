import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';

import { graderAgent } from '../agents/grader';
import { interviewerAgent } from '../agents/interviewer';
import { PROMPT_ALIGNMENT_KEY, PROMPT_ALIGNMENT_SCORER_ID } from './index';

describe('monitoring scorer wiring', () => {
  it('attaches the sampled prompt-alignment monitor to the interviewer', async () => {
    const scorers = await interviewerAgent.listScorers({ requestContext: new RequestContext() });
    const entry = scorers[PROMPT_ALIGNMENT_KEY];

    expect(entry?.scorer.id).toBe(PROMPT_ALIGNMENT_SCORER_ID);
    expect(entry?.sampling).toEqual({ type: 'ratio', rate: 0.5 });
  });

  it('attaches the sampled prompt-alignment monitor to the grader', async () => {
    const scorers = await graderAgent.listScorers({ requestContext: new RequestContext() });
    const entry = scorers[PROMPT_ALIGNMENT_KEY];

    expect(entry?.scorer.id).toBe(PROMPT_ALIGNMENT_SCORER_ID);
    expect(entry?.sampling).toEqual({ type: 'ratio', rate: 0.5 });
  });
});
