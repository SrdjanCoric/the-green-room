import { RequestContext } from '@mastra/core/request-context';

/**
 * Model tiering. The app runs every agent on one of two tiers — `smart` for the
 * reasoning-heavy roles (director, grader, coach) and `fast` for the high-volume,
 * lower-stakes roles (interviewer, assessor, parsers). The concrete model per tier
 * is chosen at run start and injected via the request context, so no agent hardcodes
 * a model: each reads its tier from the container at generate time.
 */
export type ModelTier = 'fast' | 'smart';

/** The default provider when the operator does not pass `--provider`. */
export const DEFAULT_PROVIDER = 'anthropic';

/**
 * Default model ids per tier, in the model router's bare-id form (the provider is
 * prefixed by {@link resolveModelTiers}). Overridable per run via CLI flags.
 */
export const DEFAULT_MODELS: Record<ModelTier, string> = {
  fast: 'claude-haiku-4-5',
  smart: 'claude-sonnet-4-5',
};

/** Request-context keys under which the resolved per-tier router strings are stored. */
export const MODEL_TIER_KEYS: Record<ModelTier, string> = {
  fast: 'model.fast',
  smart: 'model.smart',
};

/** Operator-supplied model selection, typically from CLI flags. */
export interface ModelTierOptions {
  provider?: string;
  fastModel?: string;
  smartModel?: string;
}

/** Fully-resolved router strings ready to hand to an agent's `model`. */
export interface ModelTiers {
  provider: string;
  fast: string;
  smart: string;
}

/** Prefix a bare model id with the provider; leave an already-qualified id untouched. */
function qualify(model: string, provider: string): string {
  return model.includes('/') ? model : `${provider}/${model}`;
}

/**
 * Resolve operator options into concrete `provider/model` router strings for both
 * tiers. Unset fields fall back to {@link DEFAULT_PROVIDER}/{@link DEFAULT_MODELS};
 * a model id that already carries its own `provider/` prefix passes through so a
 * single run can mix providers across tiers.
 */
export function resolveModelTiers(options: ModelTierOptions = {}): ModelTiers {
  const provider = options.provider?.trim() || DEFAULT_PROVIDER;
  const fast = qualify(options.fastModel?.trim() || DEFAULT_MODELS.fast, provider);
  const smart = qualify(options.smartModel?.trim() || DEFAULT_MODELS.smart, provider);
  return { provider, fast, smart };
}

/** Build a request context carrying the resolved tiers for a workflow run. */
export function buildModelRequestContext(tiers: ModelTiers): RequestContext {
  const context = new RequestContext();
  context.set(MODEL_TIER_KEYS.fast, tiers.fast);
  context.set(MODEL_TIER_KEYS.smart, tiers.smart);
  return context;
}

/**
 * Read the router string for a tier out of the request context. Falls back to the
 * tier default when the context is empty, so an agent still resolves a model when it
 * is exercised outside a configured run (for example directly in Studio).
 */
export function getTierModel(requestContext: RequestContext, tier: ModelTier): string {
  const value = requestContext.get(MODEL_TIER_KEYS[tier]);
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return qualify(DEFAULT_MODELS[tier], DEFAULT_PROVIDER);
}
