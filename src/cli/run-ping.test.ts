import { describe, expect, it } from 'vitest';

import { runPing } from './run-ping';

describe('runPing', () => {
  it('drives the ping workflow in-process and returns the echoed message', async () => {
    await expect(runPing('ping from cli')).resolves.toBe('ping from cli');
  });

  it('treats an empty string as a valid message and echoes it back', async () => {
    await expect(runPing('')).resolves.toBe('');
  });
});
