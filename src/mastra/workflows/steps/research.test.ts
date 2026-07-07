import { describe, expect, it } from 'vitest';

import { RequestContext } from '@mastra/core/request-context';

import { EMPTY_COMPANY_BRIEF, companyBriefSchema } from '../../schemas/company-brief';
import { DEFAULT_ROLE_CONTEXT, roleContextSchema } from '../../schemas/role-context';
import {
  RESEARCH_FETCH_TOOL_ID,
  RESEARCH_FETCH_TOOL_KEY,
  fetchResearchPageTool,
} from '../../tools/fetch-research-page';
import {
  RESEARCH_FETCH_BUDGET,
  buildCompanyBrief,
  buildResearchPrompt,
  createResearchBriefBuilder,
  createResearchFetchBudgetHooks,
} from './research';

describe('createResearchBriefBuilder', () => {
  const requestContext = new RequestContext();
  const cannedBrief = companyBriefSchema.parse({
    company: 'Globex',
    summary: 'Globex builds collaboration software.',
    facts: ['Founded as a platform company.'],
    sources: ['https://globex.example/about'],
  });

  it('requests structured output against the company-brief schema with a bounded fetch budget', async () => {
    let seenSchema: unknown;
    let seenContext: unknown;
    let seenMaxSteps: unknown;
    let seenPrompt = '';
    const builder = createResearchBriefBuilder(
      {
        generate: async (prompt, options) => {
          seenPrompt = prompt;
          seenSchema = options.structuredOutput.schema;
          seenContext = options.requestContext;
          seenMaxSteps = options.maxSteps;
          return { object: cannedBrief };
        },
      },
      requestContext,
    );

    const brief = await builder({
      roleContext: roleContextSchema.parse({ company: 'Globex', role: 'Staff Engineer' }),
      researchUrls: ['https://globex.example/about'],
    });

    expect(seenSchema).toBe(companyBriefSchema);
    expect(seenContext).toBe(requestContext);
    expect(seenMaxSteps).toBe(RESEARCH_FETCH_BUDGET + 1);
    expect(seenPrompt).toContain('Globex');
    expect(seenPrompt).toContain('https://globex.example/about');
    expect(brief.summary).toContain('collaboration');
  });

  it('forwards the abort signal to the agent generate call', async () => {
    let seenSignal: AbortSignal | undefined;
    const builder = createResearchBriefBuilder(
      {
        generate: async (_prompt, options) => {
          seenSignal = options.abortSignal;
          return { object: cannedBrief };
        },
      },
      requestContext,
    );

    const controller = new AbortController();
    await builder(
      { roleContext: roleContextSchema.parse({ role: 'Staff Engineer' }), researchUrls: [] },
      { abortSignal: controller.signal },
    );

    expect(seenSignal).toBe(controller.signal);
  });

  it('retries a missing structured company brief before giving up', async () => {
    const builder = createResearchBriefBuilder(
      { generate: async () => ({ object: undefined }) },
      requestContext,
    );

    await expect(
      builder({
        roleContext: roleContextSchema.parse({ company: 'Globex', role: 'Staff Engineer' }),
        researchUrls: [],
      }),
    ).rejects.toThrow(/research agent/i);
  });
});

describe('research fetch tool naming', () => {
  // The budget hook gates the tool by its *registration key* (camelCase), which is a
  // different string from the tool's own `id` (kebab-case). One shared constant keeps
  // the registration, the hook, and the prompt from drifting apart; these tests fail if
  // the two names collapse into one or a consumer stops using the shared constant.
  it('keeps the registration key distinct from the tool id', () => {
    expect(RESEARCH_FETCH_TOOL_KEY).toBe('fetchResearchPage');
    expect(RESEARCH_FETCH_TOOL_ID).toBe('fetch-research-page');
    expect(RESEARCH_FETCH_TOOL_KEY).not.toBe(RESEARCH_FETCH_TOOL_ID);
  });

  it('defines the tool with the shared id', () => {
    expect(fetchResearchPageTool.id).toBe(RESEARCH_FETCH_TOOL_ID);
  });

  it('names the shared registration key in the research prompt', () => {
    const prompt = buildResearchPrompt({ roleContext: DEFAULT_ROLE_CONTEXT, researchUrls: [] });
    expect(prompt).toContain(RESEARCH_FETCH_TOOL_KEY);
  });
});

describe('createResearchFetchBudgetHooks', () => {
  it('blocks fetchResearchPage calls after the configured budget', () => {
    const hooks = createResearchFetchBudgetHooks(2);

    expect(hooks.beforeToolCall({ toolName: RESEARCH_FETCH_TOOL_KEY })).toBeUndefined();
    expect(hooks.beforeToolCall({ toolName: RESEARCH_FETCH_TOOL_KEY })).toBeUndefined();
    expect(hooks.beforeToolCall({ toolName: RESEARCH_FETCH_TOOL_KEY })).toEqual({
      proceed: false,
      output: { text: 'Research fetch budget exhausted; no page was fetched.', url: '' },
    });
  });

  it('gates the registration key, not the kebab-case tool id', () => {
    const hooks = createResearchFetchBudgetHooks(0);

    // The tool id would slip past the budget entirely — proof the hook keys off the
    // registration name the agent actually dispatches under.
    expect(hooks.beforeToolCall({ toolName: RESEARCH_FETCH_TOOL_ID })).toBeUndefined();
    expect(hooks.beforeToolCall({ toolName: RESEARCH_FETCH_TOOL_KEY })).toMatchObject({
      proceed: false,
    });
  });

  it('does not count unrelated tool calls against the research fetch budget', () => {
    const hooks = createResearchFetchBudgetHooks(1);

    expect(hooks.beforeToolCall({ toolName: 'otherTool' })).toBeUndefined();
    expect(hooks.beforeToolCall({ toolName: RESEARCH_FETCH_TOOL_KEY })).toBeUndefined();
    expect(hooks.beforeToolCall({ toolName: RESEARCH_FETCH_TOOL_KEY })).toMatchObject({
      proceed: false,
    });
  });
});

describe('buildCompanyBrief', () => {
  it('returns a validated company brief for the happy path', async () => {
    const brief = await buildCompanyBrief({
      builder: async () =>
        companyBriefSchema.parse({
          company: 'Globex',
          summary: 'Globex builds collaboration software.',
          facts: ['Public company context.'],
          sources: ['https://globex.example/about'],
        }),
      roleContext: roleContextSchema.parse({ company: 'Globex', role: 'Staff Engineer' }),
      researchUrls: ['https://globex.example/about'],
    });

    expect(brief.company).toBe('Globex');
    expect(brief.facts).toEqual(['Public company context.']);
  });

  it('returns an empty brief when research fails', async () => {
    const brief = await buildCompanyBrief({
      builder: async () => {
        throw new Error('fetch failed');
      },
      roleContext: roleContextSchema.parse({ company: 'Globex', role: 'Staff Engineer' }),
      researchUrls: ['https://globex.example/about'],
    });

    expect(brief).toEqual(EMPTY_COMPANY_BRIEF);
  });

  it('returns an empty brief when the posting-channel injection guard blocks the call', async () => {
    // The research agent's `processInput` detector aborts the whole call in block mode
    // (a tripwire error thrown out of `generate`); the step degrades to the empty brief
    // rather than failing the run. Fetched-page injections never reach this path — the
    // step-phase page guard rewrites them in place and research continues.
    const brief = await buildCompanyBrief({
      builder: async () => {
        throw new Error('Prompt injection detected. Types: injection');
      },
      roleContext: roleContextSchema.parse({ company: 'Globex', role: 'Staff Engineer' }),
      researchUrls: ['https://attacker.example/about'],
    });

    expect(brief).toEqual(EMPTY_COMPANY_BRIEF);
  });

  it('returns an empty brief when research times out', async () => {
    const brief = await buildCompanyBrief({
      builder: async () =>
        new Promise(() => {
          // Intentionally never resolves; the research timeout should win.
        }),
      roleContext: roleContextSchema.parse({ company: 'Globex', role: 'Staff Engineer' }),
      timeoutMs: 1,
    });

    expect(brief).toEqual(EMPTY_COMPANY_BRIEF);
  });

  it('aborts the in-flight research call on timeout instead of leaving it dangling', async () => {
    let received: AbortSignal | undefined;
    const brief = await buildCompanyBrief({
      // The builder never settles on its own; only the abort signal ends it, mirroring a
      // real `generate` whose LLM call must be cancelled rather than left running.
      builder: (_input, options) =>
        new Promise((resolve) => {
          received = options?.abortSignal;
          options?.abortSignal?.addEventListener('abort', () => resolve(EMPTY_COMPANY_BRIEF));
        }),
      roleContext: roleContextSchema.parse({ company: 'Globex', role: 'Staff Engineer' }),
      timeoutMs: 1,
    });

    expect(received?.aborted).toBe(true);
    expect(brief).toEqual(EMPTY_COMPANY_BRIEF);
  });
});
