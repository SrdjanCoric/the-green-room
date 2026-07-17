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
import { KNOWLEDGE_VECTOR_STORE_NAME } from './knowledge/config';
import { knowledgeVectorStore } from './knowledge/vector-store';
import { monitoringScorers } from './scorers';
import { prepareInterviewRoute } from './server/prepare-interview-route';
import {
  voiceCapabilitiesRoute,
  voiceSpeechRoute,
  voiceTranscriptionTokenRoute,
} from './server/voice-routes';
import { storage } from './storage';
import { streamReplayCache } from './stream-cache';
import { interviewWorkflow } from './workflows/interview-workflow';

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
  workflows: { interviewWorkflow },
  // Monitoring scorers registered for Studio's catalog and `runEvals`; the interviewer
  // and grader also attach sampled copies directly, which is what drives live scoring.
  scorers: monitoringScorers,
  vectors: { [KNOWLEDGE_VECTOR_STORE_NAME]: knowledgeVectorStore },
  storage,
  // Backs resumable streaming: the server caches delivered workflow stream chunks by
  // run id and replays them through its observe endpoint, so a browser that dropped
  // mid-stream can rejoin the same run where it left off. The observe endpoint (like
  // the run endpoints generally) has no per-user authorization — run ids are
  // unguessable UUIDs and this server is assumed to stay on localhost for a single
  // user; gate the workflow run routes before ever binding it beyond that.
  cache: streamReplayCache,
  observability,
  logger: new PinoLogger({ name: 'interview-coach', level: 'info' }),
  // Same-origin browser routes prepare interview inputs and proxy timed speech;
  // the interview workflow and agents stay transport-agnostic.
  server: {
    apiRoutes: [
      prepareInterviewRoute,
      voiceCapabilitiesRoute,
      voiceSpeechRoute,
      voiceTranscriptionTokenRoute,
    ],
  },
});
