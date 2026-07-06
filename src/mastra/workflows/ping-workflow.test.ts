import { describe, expect, it } from 'vitest';

import { mastra } from '../index';

describe('ping workflow', () => {
  it('runs end-to-end through the Mastra instance and echoes its input', async () => {
    const workflow = mastra.getWorkflow('pingWorkflow');
    const run = await workflow.createRun();

    const result = await run.start({ inputData: { message: 'hello skeleton' } });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.result).toEqual({ echoed: 'hello skeleton' });
  });
});
