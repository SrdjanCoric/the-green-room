import { createStep } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';

import { RESEARCH_FETCH_TOOL_KEY } from '../../tools/fetch-research-page';
import {
  structuredCall,
  type GenerateToolHooks,
  type StructuredGenerator,
} from '../../structured-call';
import {
  EMPTY_COMPANY_BRIEF,
  companyBriefSchema,
  type CompanyBrief,
} from '../../schemas/company-brief';
import type { RoleContext } from '../../schemas/role-context';
import { ingestOutputSchema, researchOutputSchema } from '../interview-state';

export const RESEARCH_FETCH_BUDGET = 3;

export interface ResearchBriefInput {
  roleContext: RoleContext;
  researchUrls: string[];
}

export interface ResearchBriefOptions {
  /** Cancels the underlying research call when the caller's timeout wins the race. */
  abortSignal?: AbortSignal;
}

export type CompanyBriefBuilder = (
  input: ResearchBriefInput,
  options?: ResearchBriefOptions,
) => Promise<CompanyBrief>;

export function buildResearchPrompt(input: ResearchBriefInput): string {
  const role = input.roleContext;
  const companyLine = role.company ? `Company: ${role.company}` : 'Company: unknown';
  const urls =
    input.researchUrls.length > 0
      ? input.researchUrls.map((url) => `- ${url}`).join('\n')
      : '- none provided';
  return `Write a short public company brief for a behavioral interview.

${companyLine}
Role: ${role.role}
${role.summary ? `Role context: ${role.summary}` : ''}
Allowed public research URLs:
${urls}

Use the ${RESEARCH_FETCH_TOOL_KEY} tool for public company pages only when the prompt or role context gives you a public URL. Do not guess URLs. Use at most ${RESEARCH_FETCH_BUDGET} fetches. If you cannot find public context, return an empty summary, facts, and sources.`;
}

export function createResearchFetchBudgetHooks(
  maxFetches: number = RESEARCH_FETCH_BUDGET,
): GenerateToolHooks {
  let fetches = 0;
  return {
    beforeToolCall: ({ toolName }) => {
      if (toolName !== RESEARCH_FETCH_TOOL_KEY) return;
      if (fetches >= maxFetches) {
        return {
          proceed: false,
          output: { text: 'Research fetch budget exhausted; no page was fetched.', url: '' },
        };
      }
      fetches += 1;
    },
  };
}

export function createResearchBriefBuilder(
  agent: StructuredGenerator,
  requestContext: RequestContext,
): CompanyBriefBuilder {
  return async (input, options) =>
    structuredCall(agent, buildResearchPrompt(input), companyBriefSchema, requestContext, {
      description: 'research agent',
      maxSteps: RESEARCH_FETCH_BUDGET + 1,
      hooks: createResearchFetchBudgetHooks(),
      abortSignal: options?.abortSignal,
    });
}

/**
 * Default research budget: the fetch budget allows up to 3 pages, and each fetched page
 * costs an extra fast-tier detection call in the step-phase page guard, so the window
 * leaves room for both the fetches and their scans.
 */
const DEFAULT_RESEARCH_TIMEOUT_MS = 30_000;

export async function buildCompanyBrief(params: {
  builder: CompanyBriefBuilder;
  roleContext: RoleContext;
  researchUrls?: string[];
  timeoutMs?: number;
}): Promise<CompanyBrief> {
  // Cancel the research call when the timeout wins the race, so a slow `generate` (and
  // its in-flight LLM call) is torn down rather than left running past the empty brief.
  const controller = new AbortController();
  try {
    const research = params.builder(
      {
        roleContext: params.roleContext,
        researchUrls: params.researchUrls ?? [],
      },
      { abortSignal: controller.signal },
    );
    return companyBriefSchema.parse(
      await withTimeout(research, params.timeoutMs ?? DEFAULT_RESEARCH_TIMEOUT_MS, () => controller.abort()),
    );
  } catch {
    return EMPTY_COMPANY_BRIEF;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          onTimeout?.();
          reject(new Error('Company research timed out.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export const researchStep = createStep({
  id: 'research',
  inputSchema: ingestOutputSchema,
  outputSchema: researchOutputSchema,
  execute: async ({ inputData, mastra, requestContext }) => {
    const companyBrief = await buildCompanyBrief({
      builder: createResearchBriefBuilder(mastra.getAgent('research'), requestContext),
      roleContext: inputData.roleContext,
      researchUrls: inputData.researchUrls,
    });

    return { ...inputData, companyBrief };
  },
});
