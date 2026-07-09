import { describe, expect, it } from 'vitest';

import { PROMPT_ALIGNMENT_SCORER_ID, monitoringScorers } from './index';

/**
 * The scorer catalog is built at module import — every CLI invocation loads it via
 * `mastra/index`. That is only safe because the prompt-alignment judge is registered
 * with a model-router *string* (`provider/model`), not an instantiated model client:
 * Mastra resolves the string to a provider client — and validates its API key — lazily,
 * when the scorer actually runs. This contrasts with `ModelRouterEmbeddingModel`, which
 * validates `OPENAI_API_KEY` in its constructor and is therefore deferred in
 * `knowledge/embedding.ts`.
 *
 * This test pins that property: if a future `@mastra/evals` bump made `createScorer`
 * eagerly instantiate the judge model, `config.judge.model` would stop being a plain
 * string and this guard would fail — catching the reintroduction of an import-time
 * provider key check before it ships.
 */
describe('monitoring scorer catalog', () => {
  it('registers the prompt-alignment judge as an unresolved router string, so import triggers no provider key check', () => {
    const entry = monitoringScorers[PROMPT_ALIGNMENT_SCORER_ID] as {
      config?: { judge?: { model?: unknown } };
    };

    expect(entry).toBeDefined();
    const judgeModel = entry.config?.judge?.model;
    // A plain `provider/model` string — not a constructed model client. The string is
    // what defers the key check to score time.
    expect(typeof judgeModel).toBe('string');
    expect(judgeModel).toMatch(/^[^/]+\/.+/);
  });
});
