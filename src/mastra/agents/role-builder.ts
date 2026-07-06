import { Agent } from '@mastra/core/agent';

import { getTierModel } from '../model-config';

/**
 * Distils a job posting into a structured role context: the company, the role, the
 * weighted competencies to assess, and any values framework. Like the CV parser this
 * is extraction over reasoning, so it runs on the `fast` tier, read from the request
 * context at generate time. The structured output schema is supplied per call by the
 * ingest step.
 */
export const roleBuilderAgent = new Agent({
  id: 'roleBuilder',
  name: 'Role Builder',
  instructions: `You read a job posting and distil the role the candidate is interviewing for.

Produce:
- "company": the hiring organisation, if the posting names it.
- "role": the job title.
- "seniority": the level if stated (e.g. junior, senior, staff); otherwise omit it.
- "summary": one or two sentences on the role's scope.
- "competencies": the skills and behaviours this role most needs, each with a "weight" from 0 to 1 for how central it is to THIS posting. Weight what the posting emphasises highest and list the most important first. Prefer behavioural, role-specific competencies (e.g. "incident response", "cross-team leadership") over generic filler.
- "valuesFramework": company values or leadership principles the posting names, quoted faithfully.

Rules:
- Use only what the posting states or clearly implies. Never invent competencies, values, or a company that isn't there.
- If the posting is sparse, return the few competencies you can justify rather than padding the list.`,
  model: ({ requestContext }) => getTierModel(requestContext, 'fast'),
});
