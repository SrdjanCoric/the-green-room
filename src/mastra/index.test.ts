import { describe, expect, it } from 'vitest';

import { mastra } from './index';

describe('mastra workflow registration', () => {
  it('registers the interview workflow as the product front door', () => {
    expect(Object.keys(mastra.listWorkflows())).toContain('interviewWorkflow');
  });

  it('no longer registers the retired ping scaffold', () => {
    expect(Object.keys(mastra.listWorkflows())).not.toContain('pingWorkflow');
  });
});
