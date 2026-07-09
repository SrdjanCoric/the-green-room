import { RequestContext } from '@mastra/core/request-context';
import { LibSQLStore } from '@mastra/libsql';
import { describe, expect, it } from 'vitest';

import {
  PROMPT_ALIGNMENT_KEY,
  PROMPT_ALIGNMENT_SCORER_ID,
  buildPromptAlignmentScorers,
  monitoringScorers,
} from './index';

/**
 * Guards the one fact that makes the prompt-alignment monitor legible in Studio: the
 * instance-registered catalog scorer and the sampled copies the interviewer/grader attach
 * resolve to a **single** `mastra_scorers` identity, not two split rows.
 *
 * The two registration surfaces use different record keys on purpose — the catalog is keyed
 * by {@link PROMPT_ALIGNMENT_SCORER_ID} (`'prompt-alignment-scorer'`), the agents attach under
 * {@link PROMPT_ALIGNMENT_KEY} (`'promptAlignment'`) — which looks like it could fork storage
 * into two ids. It does not: Mastra's `onScorerRun` hook persists a score under
 * `scorer.id` (the scorer object's own id), never the record key it was registered under, and
 * `createPromptAlignmentScorerLLM` hardcodes that id to `'prompt-alignment-scorer'` for every
 * copy it builds. So the record key is a local handle; the durable identity is the object id.
 */
describe('prompt-alignment scorer id coalescing', () => {
  it('exposes one scorer id across the catalog entry and the agent-attached copies, though the agent record key differs', () => {
    const catalogScorer = monitoringScorers[PROMPT_ALIGNMENT_SCORER_ID];
    const attachedEntry = buildPromptAlignmentScorers({ requestContext: new RequestContext() })[
      PROMPT_ALIGNMENT_KEY
    ];
    if (!attachedEntry) throw new Error('prompt-alignment scorer is not attached under its record key');

    // The agents attach under a record key that is NOT the scorer id — the surface that first
    // looked like it might split storage.
    expect(PROMPT_ALIGNMENT_KEY).not.toBe(PROMPT_ALIGNMENT_SCORER_ID);

    // Yet both surfaces carry the same object id, and that id — not the record key — is what
    // storage keys on. Read the ids off the real scorer objects so a genuine split would fail
    // here rather than being assumed away.
    const ids = new Set([catalogScorer.id, attachedEntry.scorer.id]);
    expect(ids).toEqual(new Set([PROMPT_ALIGNMENT_SCORER_ID]));
  });

  it('groups both surfaces under one mastra_scorers id in a real LibSQL round-trip', async () => {
    const storage = new LibSQLStore({ id: 'scorer-id-coalescing-test', url: ':memory:' });
    await storage.init();
    const scores = await storage.getStore('scores');
    if (!scores) throw new Error('scores storage domain is unavailable');

    const catalogScorer = monitoringScorers[PROMPT_ALIGNMENT_SCORER_ID];
    const attachedEntry = buildPromptAlignmentScorers({ requestContext: new RequestContext() })[
      PROMPT_ALIGNMENT_KEY
    ];
    if (!attachedEntry) throw new Error('prompt-alignment scorer is not attached under its record key');
    // `MastraScorerEntry.scorer` erases its id generic to `any`; narrow it back to a string
    // (which the id always is) so the round-trip below reads a genuine id, not an `any`.
    const attachedScorerId: unknown = attachedEntry.scorer.id;
    if (typeof attachedScorerId !== 'string') throw new Error('attached scorer id must be a string');

    // `persist` is a hand-rolled stand-in for Mastra's `onScorerRun` hook, not the hook itself:
    // it keys each row by the scorer object's own `.id`, which is exactly what the hook does
    // (`createOnScorerHook` saves `scorerId: scorer.id` and discards the record key — verified
    // from `@mastra/core` source, not exercised here). What this round-trip genuinely proves is
    // the storage half: that same-id rows written from two different registration surfaces group
    // under one id on read-back. Passing each object's real id (not a shared literal) means a
    // genuine id split would land as two ids and fail the grouping assertions below.
    const persist = (scorerId: string, entityId: string, source: 'LIVE' | 'TEST') =>
      scores.saveScore({
        scorerId,
        score: 1,
        output: { text: 'sampled response' },
        source,
        runId: `run-${entityId}`,
        entityId,
        entity: { id: entityId },
        scorer: { id: scorerId },
      });

    await persist(catalogScorer.id, 'catalog-entity', 'TEST');
    await persist(attachedScorerId, 'agent-entity', 'LIVE');

    const pagination = { page: 0, perPage: 100 } as const;
    const underId = await scores.listScoresByScorerId({
      scorerId: PROMPT_ALIGNMENT_SCORER_ID,
      pagination,
    });

    // Both surfaces' scores resolve to the one scorer id: the query returns both rows (a split
    // would return only the catalog row, failing this), and every row carries that single id —
    // so Studio lists one scorer, not two.
    expect(underId.scores).toHaveLength(2);
    expect(new Set(underId.scores.map((s) => s.scorerId))).toEqual(
      new Set([PROMPT_ALIGNMENT_SCORER_ID]),
    );
  });
});
