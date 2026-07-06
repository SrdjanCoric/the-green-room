import { z } from 'zod';

export const companyBriefSchema = z.object({
  company: z.string().optional().describe('Company name if known.'),
  summary: z.string().default('').describe('A short company brief for interview context.'),
  facts: z
    .array(z.string())
    .default([])
    .describe('Concrete public facts or context points the interviewer can use.'),
  sources: z.array(z.string()).default([]).describe('Public URLs used to build the brief.'),
});

export type CompanyBrief = z.infer<typeof companyBriefSchema>;

export const EMPTY_COMPANY_BRIEF: CompanyBrief = companyBriefSchema.parse({});
