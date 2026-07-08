import { describe, expect, it } from 'vitest';

import { createStreamReplayCache, STREAM_REPLAY_MAX_RUNS } from './stream-cache';

describe('the stream replay cache', () => {
  it('bounds the number of cached runs, evicting the oldest when full', async () => {
    const cache = createStreamReplayCache({ maxSize: 2 });

    await cache.set('run-a', ['chunk']);
    await cache.set('run-b', ['chunk']);
    await cache.set('run-c', ['chunk']);

    // 'run-a' was the oldest entry; the bound pushed it out while the TTL was
    // still live, so many concurrent runs can no longer grow memory unboundedly.
    expect(await cache.get('run-a')).toBeUndefined();
    expect(await cache.get('run-b')).toEqual(['chunk']);
    expect(await cache.get('run-c')).toEqual(['chunk']);
  });

  it('ships with a documented default bound', () => {
    expect(STREAM_REPLAY_MAX_RUNS).toBeGreaterThan(0);
  });
});
