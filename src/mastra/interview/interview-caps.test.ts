import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CAP_LIMITS,
  estimateTokens,
  INITIAL_COVERAGE,
  allowQuestion,
  capLimitsSchema,
  coverageStateSchema,
  followUpCapReached,
  questionCapReached,
  repromptCapReached,
  tokenBudgetExhausted,
} from './interview-caps';

const limits = capLimitsSchema.parse({
  maxQuestions: 3,
  maxConsecutiveFollowUps: 2,
  maxReprompts: 1,
  tokenBudget: 1000,
});

describe('coverage cap predicates', () => {
  it('reports the question cap reached only once the count meets the ceiling', () => {
    expect(questionCapReached(coverageStateSchema.parse({ questionCount: 2 }), limits)).toBe(false);
    expect(questionCapReached(coverageStateSchema.parse({ questionCount: 3 }), limits)).toBe(true);
    expect(questionCapReached(coverageStateSchema.parse({ questionCount: 4 }), limits)).toBe(true);
  });

  it('reports the consecutive-follow-up cap reached at the ceiling', () => {
    expect(followUpCapReached(coverageStateSchema.parse({ consecutiveFollowUps: 1 }), limits)).toBe(false);
    expect(followUpCapReached(coverageStateSchema.parse({ consecutiveFollowUps: 2 }), limits)).toBe(true);
  });

  it('reports the reprompt cap reached at the ceiling', () => {
    expect(repromptCapReached(coverageStateSchema.parse({ repromptCount: 0 }), limits)).toBe(false);
    expect(repromptCapReached(coverageStateSchema.parse({ repromptCount: 1 }), limits)).toBe(true);
  });

  it('reports the token budget exhausted once usage meets it', () => {
    expect(tokenBudgetExhausted(coverageStateSchema.parse({ tokensUsed: 999 }), limits)).toBe(false);
    expect(tokenBudgetExhausted(coverageStateSchema.parse({ tokensUsed: 1000 }), limits)).toBe(true);
  });
});

describe('allowQuestion', () => {
  it('allows a new question while every cap has headroom', () => {
    expect(allowQuestion(INITIAL_COVERAGE, limits, 'new')).toEqual({ allowed: true, reason: null });
  });

  it('blocks any question once the total-question cap is reached', () => {
    const state = coverageStateSchema.parse({ questionCount: 3 });
    expect(allowQuestion(state, limits, 'new')).toEqual({ allowed: false, reason: 'question-cap' });
    expect(allowQuestion(state, limits, 'follow-up')).toEqual({ allowed: false, reason: 'question-cap' });
  });

  it('blocks any question once the token budget is exhausted', () => {
    const state = coverageStateSchema.parse({ tokensUsed: 1000 });
    expect(allowQuestion(state, limits, 'new')).toEqual({ allowed: false, reason: 'token-budget' });
  });

  it('blocks only a follow-up when the follow-up cap is reached, not a new question', () => {
    const state = coverageStateSchema.parse({ consecutiveFollowUps: 2 });
    expect(allowQuestion(state, limits, 'follow-up')).toEqual({ allowed: false, reason: 'follow-up-cap' });
    expect(allowQuestion(state, limits, 'new')).toEqual({ allowed: true, reason: null });
  });

  it('blocks only a reprompt when the reprompt cap is reached, not a new question', () => {
    const state = coverageStateSchema.parse({ repromptCount: 1 });
    expect(allowQuestion(state, limits, 'reprompt')).toEqual({ allowed: false, reason: 'reprompt-cap' });
    expect(allowQuestion(state, limits, 'new')).toEqual({ allowed: true, reason: null });
  });

  it('reports the total-question cap before a kind-specific cap when both are hit', () => {
    const state = coverageStateSchema.parse({ questionCount: 3, consecutiveFollowUps: 2 });
    expect(allowQuestion(state, limits, 'follow-up')).toEqual({ allowed: false, reason: 'question-cap' });
  });

  it('ships defaults that bound a session', () => {
    expect(DEFAULT_CAP_LIMITS.maxQuestions).toBeGreaterThan(0);
    expect(DEFAULT_CAP_LIMITS.tokenBudget).toBeGreaterThan(0);
  });
});

describe('estimateTokens', () => {
  it('grows with the length of the text and is zero for empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(40))).toBeGreaterThan(estimateTokens('a'.repeat(4)));
  });
});
