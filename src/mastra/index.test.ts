import { describe, expect, it } from 'vitest';

import { mastra } from './index';
import { KNOWLEDGE_VECTOR_STORE_NAME } from './knowledge/config';

describe('mastra workflow registration', () => {
  it('registers the interview workflow as the product front door', () => {
    expect(Object.keys(mastra.listWorkflows())).toContain('interviewWorkflow');
  });

  it('no longer registers the retired ping scaffold', () => {
    expect(Object.keys(mastra.listWorkflows())).not.toContain('pingWorkflow');
  });
});

describe('mastra vector store registration', () => {
  it('registers the knowledge vector store so the coach retrieval tool can resolve it by name', () => {
    expect(mastra.getVector(KNOWLEDGE_VECTOR_STORE_NAME)).toBeDefined();
  });
});
