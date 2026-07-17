import { describe, expect, it, vi } from 'vitest';

import {
  detectQuestionSpeech,
  detectVoiceCapabilities,
  requestTranscriptionToken,
} from './voiceApi';

describe('voice capability detection', () => {
  it('reports speech and transcription independently for a valid browser and server response', async () => {
    const fetchImpl = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        void input;
        void init;
        return new Response(JSON.stringify({ speech: true, transcription: true }), { status: 200 });
      },
    );

    await expect(
      detectVoiceCapabilities({
        fetchImpl,
        supportsPlayback: () => false,
        supportsTranscription: () => true,
      }),
    ).resolves.toEqual({ speech: false, transcription: true });
    await expect(
      detectQuestionSpeech({ fetchImpl: fetchImpl, supportsPlayback: () => true }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
      vi.fn(async () =>
        new Response(JSON.stringify({ speech: 'yes', transcription: true }), { status: 200 }),
      ),
    ];

    for (const fetchImpl of cases) {
      await expect(
        detectQuestionSpeech({ fetchImpl, supportsPlayback: () => true }),
      ).resolves.toBe(false);
    }
  });

  it('requests a fresh no-store transcription token only when called', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ token: 'sutkn_one-use' }), { status: 200 }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(requestTranscriptionToken({ fetchImpl })).resolves.toBe('sutkn_one-use');
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      '/voice/transcription-token',
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    );
  });

  it('rejects token status, malformed response, and timeout failures without response details', async () => {
    for (const fetchImpl of [
      vi.fn(async () => new Response('server-secret', { status: 502 })),
      vi.fn(async () => new Response(JSON.stringify({ token: '' }), { status: 200 })),
    ]) {
      await expect(requestTranscriptionToken({ fetchImpl })).rejects.toThrow(
        'Dictation could not connect.',
      );
    }
  });
});
