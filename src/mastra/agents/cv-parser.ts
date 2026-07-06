import { Agent } from '@mastra/core/agent';

import { candidateMemory } from '../memory';
import { getTierModel } from '../model-config';

/**
 * Turns raw CV text into a structured candidate profile. This is a fast-tier role:
 * it is extraction, not reasoning, so it reads the `fast` model from the request
 * context at generate time rather than hardcoding one. The structured output schema
 * is supplied per call by the ingest step.
 */
export const cvParserAgent = new Agent({
  id: 'cvParser',
  name: 'CV Parser',
  instructions: `You extract a structured professional profile from the raw text of a candidate's CV.

Rules:
- Use only what the CV states or clearly implies. Never invent employers, dates, metrics, or skills.
- Prefer the candidate's own wording for titles, companies, and technologies.
- "quantifiedClaims" are achievements with concrete numbers (percentages, dollar amounts, counts, time saved). Copy them faithfully.
- Order roles most-recent first.
- If a field is genuinely absent from the CV, leave it out rather than guessing.`,
  model: ({ requestContext }) => getTierModel(requestContext, 'fast'),
  memory: candidateMemory,
});
