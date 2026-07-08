import { describe, expect, it } from 'vitest';

import { mastra } from './index';
import { KNOWLEDGE_VECTOR_STORE_NAME } from './knowledge/config';
import { streamReplayCache } from './stream-cache';

describe('mastra workflow registration', () => {
  it('registers the interview workflow as the product front door', () => {
    expect(Object.keys(mastra.listWorkflows())).toContain('interviewWorkflow');
  });

  it('no longer registers the retired ping scaffold', () => {
    expect(Object.keys(mastra.listWorkflows())).not.toContain('pingWorkflow');
  });
});

describe('mastra resumable streaming', () => {
  it('serves stream replays from the interview-scale chunk cache', () => {
    // The server's observe endpoint replays a run's cached chunks from this cache,
    // so a reconnecting browser can rejoin an in-flight stream by run id. The
    // explicit instance carries an interview-scale TTL — the default cache forgets
    // a run after five quiet minutes, shorter than a candidate thinking through an
    // answer.
    expect(mastra.getServerCache()).toBe(streamReplayCache);
  });
});

describe('mastra vector store registration', () => {
  it('registers the knowledge vector store so the coach retrieval tool can resolve it by name', () => {
    expect(mastra.getVector(KNOWLEDGE_VECTOR_STORE_NAME)).toBeDefined();
  });
});
