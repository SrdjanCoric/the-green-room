import { mastra } from '../mastra/index';

/**
 * Drives the `ping` workflow in-process — the same `createRun` → `start` path a
 * remote client would use over the Mastra server — and returns the echoed
 * message. Throws if the run does not complete successfully.
 */
export async function runPing(message: string): Promise<string> {
  const workflow = mastra.getWorkflow('pingWorkflow');
  const run = await workflow.createRun();
  const result = await run.start({ inputData: { message } });

  if (result.status !== 'success') {
    throw new Error(`Ping workflow did not succeed (status: ${result.status}).`);
  }

  return result.result.echoed;
}
