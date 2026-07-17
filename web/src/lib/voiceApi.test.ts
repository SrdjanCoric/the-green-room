import { describe, expect, it, vi } from 'vitest';

import { detectQuestionSpeech } from './voiceApi';

describe('voice capability detection', () => {
  it('enables question speech only for a valid configured response and supported playback', async () => {
    const fetchImpl = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        void input;
        void init;
        return new Response(JSON.stringify({ speech: true }), { status: 200 });
      },
    );

    await expect(
      detectQuestionSpeech({ fetchImpl: fetchImpl, supportsPlayback: () => true }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/voice/capabilities');
    expect(init?.headers).toEqual({ accept: 'application/json' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    await expect(
      detectQuestionSpeech({ fetchImpl: fetchImpl, supportsPlayback: () => false }),
    ).resolves.toBe(false);
  });

  it('falls back to text for network, status, and malformed capability failures', async () => {
    const cases: typeof fetch[] = [
      vi.fn(async () => Promise.reject(new Error('offline'))),
      vi.fn(async () => new Response('{}', { status: 503 })),
      vi.fn(async () => new Response(JSON.stringify({ speech: 'yes' }), { status: 200 })),
    ];

    for (const fetchImpl of cases) {
      await expect(
        detectQuestionSpeech({ fetchImpl, supportsPlayback: () => true }),
      ).resolves.toBe(false);
    }
  });
});
