import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const pingInput = z.object({
  message: z.string().describe('The message to echo back.'),
});

const pingOutput = z.object({
  echoed: z.string().describe('The echoed message.'),
});

const pingStep = createStep({
  id: 'ping',
  inputSchema: pingInput,
  outputSchema: pingOutput,
  execute: async ({ inputData }) => {
    return { echoed: inputData.message };
  },
});

/**
 * The thinnest possible workflow: a single `ping` step that echoes its input.
 * It exists to prove the end-to-end path — instance, storage, observability,
 * and the in-process runner — before any real interview logic hangs off it.
 */
export const pingWorkflow = createWorkflow({
  id: 'pingWorkflow',
  inputSchema: pingInput,
  outputSchema: pingOutput,
})
  .then(pingStep)
  .commit();
