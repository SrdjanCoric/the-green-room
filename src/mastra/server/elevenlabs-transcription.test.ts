import { describe, expect, it, vi } from 'vitest';

import {
  createElevenLabsTranscriptionTokenAdapter,
  TranscriptionTokenProviderError,
} from './elevenlabs-transcription';

describe('ElevenLabs transcription token adapter', () => {
  it('creates a realtime Scribe single-use token without exposing the API key', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ token: 'sutkn_one-use' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const adapter = createElevenLabsTranscriptionTokenAdapter({
      apiKey: 'server-secret',
      fetchImpl,
    });

    await expect(adapter.create(new AbortController().signal)).resolves.toBe('sutkn_one-use');
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe',
      expect.objectContaining({
        method: 'POST',
        headers: { accept: 'application/json', 'xi-api-key': 'server-secret' },
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    );
  });

  it('maps upstream, invalid-response, and bounded-timeout failures', async () => {
    const upstream = createElevenLabsTranscriptionTokenAdapter({
      apiKey: 'server-secret',
      fetchImpl: vi.fn(async () => new Response('provider details', { status: 401 })),
    });
    await expect(upstream.create(new AbortController().signal)).rejects.toMatchObject({
      name: 'TranscriptionTokenProviderError',
      kind: 'upstream',
    });

    const invalid = createElevenLabsTranscriptionTokenAdapter({
      apiKey: 'server-secret',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ token: '' }), { status: 200 })),
    });
    await expect(invalid.create(new AbortController().signal)).rejects.toMatchObject({
      kind: 'invalid-response',
    });

    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('request aborted')),
          { once: true },
        );
      });
    const timedOut = createElevenLabsTranscriptionTokenAdapter({
      apiKey: 'server-secret',
      timeoutMs: 5,
      fetchImpl: hangingFetch,
    });
    await expect(timedOut.create(new AbortController().signal)).rejects.toEqual(
      expect.objectContaining<Partial<TranscriptionTokenProviderError>>({ kind: 'timeout' }),
    );
  });
});
