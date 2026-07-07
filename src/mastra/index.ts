import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { MastraStorageExporter, Observability } from '@mastra/observability';

import { assessorAgent } from './agents/assessor';
import { coachAgent } from './agents/coach';
import { cvParserAgent } from './agents/cv-parser';
import { directorAgent } from './agents/director';
import { graderAgent } from './agents/grader';
import { interviewerAgent } from './agents/interviewer';
import { researchAgent } from './agents/research';
import { roleBuilderAgent } from './agents/role-builder';
import { storage } from './storage';
import { interviewWorkflow } from './workflows/interview-workflow';
import { pingWorkflow } from './workflows/ping-workflow';

/**
 * Native observability. The `MastraStorageExporter` persists AI traces into the
 * configured storage, which surfaces every run as a trace in Studio. (LibSQL
 * logs a benign warning that it does not batch-create metrics; traces are
 * unaffected.)
 */
const observability = new Observability({
  configs: {
    default: {
      serviceName: 'interview-coach',
      exporters: [new MastraStorageExporter()],
    },
  },
});

export const mastra = new Mastra({
  agents: {
    cvParser: cvParserAgent,
    roleBuilder: roleBuilderAgent,
    research: researchAgent,
    director: directorAgent,
    interviewer: interviewerAgent,
    assessor: assessorAgent,
    grader: graderAgent,
    coach: coachAgent,
  },
  workflows: { pingWorkflow, interviewWorkflow },
  storage,
  observability,
  logger: new PinoLogger({ name: 'interview-coach', level: 'info' }),
});
