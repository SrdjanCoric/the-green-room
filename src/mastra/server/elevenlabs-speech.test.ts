import { describe, expect, it, vi } from 'vitest';

import {
  createElevenLabsSpeechAdapter,
  DEFAULT_ELEVENLABS_MODEL,
  DEFAULT_ELEVENLABS_VOICE_ID,
} from './elevenlabs-speech';

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const values: T[] = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) return values;
    values.push(result.value);
  }
}

describe('ElevenLabs speech adapter', () => {
  it('normalizes streamed provider chunks into the app timing contract', async () => {
    const fetchMock = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        void input;
        void init;
        return new Response(
          `${JSON.stringify({
            audio_base64: 'YXVkaW8=',
            alignment: {
              characters: ['H', 'i'],
              character_start_times_seconds: [0, 0.12],
              character_end_times_seconds: [0.12, 0.25],
            },
          })}\n`,
          { status: 200 },
        );
      },
    );
    const adapter = createElevenLabsSpeechAdapter({
      apiKey: 'server-secret',
      fetchImpl: fetchMock,
    });

    const chunks = await readAll(
      await adapter.synthesize('Hi', new AbortController().signal),
    );

    expect(chunks).toEqual([
      {
        audioBase64: 'YXVkaW8=',
        alignment: { characters: ['H', 'i'], startsMs: [0, 120], endsMs: [120, 250] },
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_ELEVENLABS_VOICE_ID}/stream/with-timestamps?output_format=mp3_44100_128`,
    );
    expect(init?.headers).toMatchObject({ 'xi-api-key': 'server-secret' });
    expect(init?.body).toBe(JSON.stringify({ text: 'Hi', model_id: DEFAULT_ELEVENLABS_MODEL }));
    expect(typeof url).toBe('string');
    expect(typeof init?.body).toBe('string');
    if (typeof url !== 'string' || typeof init?.body !== 'string') throw new Error('bad request');
    expect(url).not.toContain('server-secret');
    expect(init.body).not.toContain('server-secret');
  });

  it('keeps audio-only provider chunks with empty app alignment', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        `${JSON.stringify({
          audio_base64: 'dGFpbC1hdWRpbw==',
          alignment: null,
          normalized_alignment: null,
        })}\n`,
        { status: 200 },
      ),
    );
    const adapter = createElevenLabsSpeechAdapter({
      apiKey: 'server-secret',
      fetchImpl,
    });

    const chunks = await readAll(
      await adapter.synthesize('Hi', new AbortController().signal),
    );

    expect(chunks).toEqual([
      {
        audioBase64: 'dGFpbC1hdWRpbw==',
        alignment: { characters: [], startsMs: [], endsMs: [] },
      },
    ]);
  });

  it('rejects malformed provider alignment instead of forwarding it', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        `${JSON.stringify({
          audio_base64: 'YXVkaW8=',
          alignment: {
            characters: ['H', 'i'],
            character_start_times_seconds: [0],
            character_end_times_seconds: [0.1, 0.2],
          },
        })}\n`,
        { status: 200 },
      ),
    );
    const adapter = createElevenLabsSpeechAdapter({
      apiKey: 'server-secret',
      fetchImpl: fetchImpl,
    });

    const stream = await adapter.synthesize('Hi', new AbortController().signal);

    await expect(readAll(stream)).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('bounds provider request duration and reports a timeout without provider text', async () => {
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('timed out', 'TimeoutError')),
            { once: true },
          );
        }),
    );
    const adapter = createElevenLabsSpeechAdapter({
      apiKey: 'server-secret',
      fetchImpl: fetchImpl,
      timeoutMs: 1,
    });

    await expect(
      adapter.synthesize('Hi', new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'timeout', message: 'Speech generation timed out.' });
  });
});
