import { z } from 'zod';

/**
 * A single position from the candidate's employment history.
 */
export const candidateRoleSchema = z.object({
  title: z.string().describe('Job title held in this role.'),
  company: z.string().optional().describe('Employer name.'),
  startDate: z.string().optional().describe('Start date as written on the CV (free-form).'),
  endDate: z.string().optional().describe('End date, or "present", as written on the CV.'),
  summary: z.string().optional().describe('One or two sentences on scope and impact.'),
});

/**
 * A project, product, or notable body of work called out on the CV.
 */
export const candidateProjectSchema = z.object({
  name: z.string().describe('Project or product name.'),
  description: z.string().optional().describe('What the project was and the candidate’s part in it.'),
  technologies: z
    .array(z.string())
    .default([])
    .describe('Technologies used specifically on this project.'),
});

/**
 * The structured candidate profile extracted from a CV. This doubles as the
 * agent's working-memory shape: it is populated once during ingest and read back
 * by later interview steps, so it carries only durable facts about the candidate,
 * not conversation state.
 */
export const candidateProfileSchema = z.object({
  name: z.string().optional().describe('Candidate’s full name.'),
  headline: z.string().optional().describe('Current title or one-line professional summary.'),
  yearsExperience: z
    .number()
    .optional()
    .describe('Total years of professional experience, if stated or clearly inferable.'),
  roles: z
    .array(candidateRoleSchema)
    .default([])
    .describe('Employment history, most recent first.'),
  projects: z
    .array(candidateProjectSchema)
    .default([])
    .describe('Notable projects or products.'),
  quantifiedClaims: z
    .array(z.string())
    .default([])
    .describe('Achievements stated with concrete numbers, e.g. "reduced p99 latency by 40%".'),
  technologies: z
    .array(z.string())
    .default([])
    .describe('Languages, frameworks, and tools the candidate lists as skills.'),
});

export type CandidateRole = z.infer<typeof candidateRoleSchema>;
export type CandidateProject = z.infer<typeof candidateProjectSchema>;
export type CandidateProfile = z.infer<typeof candidateProfileSchema>;
