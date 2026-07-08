import { describe, expect, it } from 'vitest';

import { collectAnswer } from './terminal-input';

describe('collectAnswer', () => {
  it('joins lines until the /done sentinel and trims the result', async () => {
    const lines = ['First line.', 'Second line.', '/done', 'ignored after done'];
    let i = 0;
    const answer = await collectAnswer(async () => (i < lines.length ? (lines[i++] ?? null) : null));

    expect(answer).toBe('First line.\nSecond line.');
  });

  it('stops at end of input even without a sentinel', async () => {
    const lines = ['Only line.'];
    let i = 0;
    const answer = await collectAnswer(async () => (i < lines.length ? (lines[i++] ?? null) : null));

    expect(answer).toBe('Only line.');
  });

  it('returns an empty string when the answer is blank', async () => {
    const answer = await collectAnswer(async () => '/done');
    expect(answer).toBe('');
  });
});
