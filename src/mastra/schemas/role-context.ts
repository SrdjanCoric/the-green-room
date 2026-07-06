import { z } from 'zod';

/**
 * A single competency the role evaluates, carrying a weight so the interview can
 * spend its limited turns on what this posting cares about most.
 */
export const competencySchema = z.object({
  name: z
    .string()
    .describe('A competency the role evaluates, e.g. "system design" or "stakeholder management".'),
  weight: z
    .number()
    .min(0)
    .max(1)
    .describe(
      'Relative importance from 0 (peripheral) to 1 (central); higher competencies are probed more in the interview.',
    ),
});

/**
 * The role the candidate is interviewing for, distilled from a job posting: who is
 * hiring, for what, the competencies to assess (weighted), and any values framework
 * the posting emphasizes. Downstream the director uses the weights to steer the
 * interview and the grader uses them to score.
 */
export const roleContextSchema = z.object({
  company: z.string().optional().describe('Hiring company name, if the posting identifies it.'),
  role: z.string().describe('The job title the candidate is interviewing for.'),
  seniority: z
    .string()
    .optional()
    .describe('Seniority level as stated, e.g. "junior", "senior", "staff".'),
  summary: z.string().optional().describe('One or two sentences describing the role and its scope.'),
  competencies: z
    .array(competencySchema)
    .default([])
    .describe('Weighted competencies the interview should assess, most important first.'),
  valuesFramework: z
    .array(z.string())
    .default([])
    .describe('Company values or leadership principles the posting emphasizes, quoted faithfully.'),
});

export type Competency = z.infer<typeof competencySchema>;
export type RoleContext = z.infer<typeof roleContextSchema>;

/**
 * The role context used when the candidate provides no job posting: a generic
 * behavioral interview weighting the competencies common to most roles equally, so
 * the interview can still proceed. Parsed through the schema so it is guaranteed
 * valid and array defaults are applied.
 */
export const DEFAULT_ROLE_CONTEXT: RoleContext = roleContextSchema.parse({
  role: 'General behavioral interview',
  summary: 'No job posting was provided; running a general behavioral interview.',
  competencies: [
    { name: 'Communication', weight: 0.5 },
    { name: 'Problem solving', weight: 0.5 },
    { name: 'Collaboration', weight: 0.5 },
    { name: 'Ownership', weight: 0.5 },
  ],
});
