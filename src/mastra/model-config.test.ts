import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROVIDER,
  buildModelRequestContext,
  getTierModel,
  resolveModelTiers,
} from './model-config';

describe('resolveModelTiers', () => {
  it('defaults to Anthropic smart/fast router strings when nothing is provided', () => {
    const tiers = resolveModelTiers();

    expect(tiers.provider).toBe(DEFAULT_PROVIDER);
    expect(tiers.fast).toMatch(/^anthropic\//);
    expect(tiers.smart).toMatch(/^anthropic\//);
    expect(tiers.fast).not.toBe(tiers.smart);
  });

  it('qualifies bare model ids with the chosen provider', () => {
    const tiers = resolveModelTiers({
      provider: 'openai',
      fastModel: 'gpt-fast',
      smartModel: 'gpt-smart',
    });

    expect(tiers.fast).toBe('openai/gpt-fast');
    expect(tiers.smart).toBe('openai/gpt-smart');
  });

  it('passes a fully-qualified provider/model override through untouched', () => {
    const tiers = resolveModelTiers({
      provider: 'anthropic',
      smartModel: 'openai/gpt-5',
    });

    expect(tiers.smart).toBe('openai/gpt-5');
  });
});

describe('model tier request context', () => {
  it('round-trips resolved tiers through the request context', () => {
    const tiers = resolveModelTiers({ provider: 'anthropic' });
    const ctx = buildModelRequestContext(tiers);

    expect(getTierModel(ctx, 'fast')).toBe(tiers.fast);
    expect(getTierModel(ctx, 'smart')).toBe(tiers.smart);
  });
});
