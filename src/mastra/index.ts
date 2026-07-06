import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { MastraStorageExporter, Observability } from '@mastra/observability';

import { cvParserAgent } from './agents/cv-parser';
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
  agents: { cvParser: cvParserAgent },
  workflows: { pingWorkflow, interviewWorkflow },
  storage,
  observability,
  logger: new PinoLogger({ name: 'interview-coach', level: 'info' }),
});
