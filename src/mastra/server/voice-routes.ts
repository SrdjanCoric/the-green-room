import { registerApiRoute } from '@mastra/core/server';
import { bodyLimit } from 'hono/body-limit';

import type { VoiceSpeechChunk } from '../../../shared/voice-contract';
import {
  createElevenLabsSpeechAdapter,
  SpeechProviderError,
} from './elevenlabs-speech';

export const MAX_SPEECH_CHARACTERS = 2_000;
export const MAX_SPEECH_BODY_BYTES = 12 * 1_024;

export interface SpeechAdapter {
  synthesize(text: string, signal: AbortSignal): Promise<ReadableStream<VoiceSpeechChunk>>;
}

export interface VoiceRouteContext {
  req: {
    json: () => Promise<unknown>;
    raw?: { signal: AbortSignal };
  };
  json: (data: unknown, status?: number) => Response;
}

export function createVoiceCapabilitiesHandler({
  speechAvailable,
}: {
  speechAvailable: boolean;
}) {
  return (c: VoiceRouteContext): Response => c.json({ speech: speechAvailable });
}

export function createVoiceSpeechHandler({ adapter }: { adapter: SpeechAdapter | undefined }) {
  return async (c: VoiceRouteContext): Promise<Response> => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Question text is required.' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'Question text is required.' }, 400);
    }
    const text = (body as Record<string, unknown>).text;
    if (
      typeof text !== 'string' ||
      text.trim().length === 0 ||
      text.length > MAX_SPEECH_CHARACTERS
    ) {
      return c.json({ error: 'Question text is invalid.' }, 400);
    }

    if (!adapter) {
      return c.json({ error: 'Spoken delivery is unavailable.' }, 503);
    }

    let chunks: ReadableStream<VoiceSpeechChunk>;
    try {
      chunks = await adapter.synthesize(
        text,
        c.req.raw?.signal ?? new AbortController().signal,
      );
    } catch (error) {
      const status = error instanceof SpeechProviderError && error.kind === 'timeout' ? 504 : 502;
      return c.json({ error: 'Spoken delivery is unavailable.' }, status);
    }
    const encoder = new TextEncoder();
    const lines = chunks.pipeThrough(
      new TransformStream<VoiceSpeechChunk, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
        },
      }),
    );
    return new Response(lines, {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/x-ndjson; charset=utf-8',
      },
    });
  };
}

export function createVoiceBodyLimit(maxSize: number = MAX_SPEECH_BODY_BYTES) {
  return bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: 'Question text is invalid.' }, 413),
  });
}

const apiKey = nonEmptyEnvironmentValue('ELEVENLABS_API_KEY');
const speechAdapter = apiKey
  ? createElevenLabsSpeechAdapter({
      apiKey,
      voiceId: nonEmptyEnvironmentValue('ELEVENLABS_VOICE_ID'),
      model: nonEmptyEnvironmentValue('ELEVENLABS_TTS_MODEL'),
    })
  : undefined;

function nonEmptyEnvironmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === '' ? undefined : value;
}

export const voiceCapabilitiesRoute = registerApiRoute('/voice/capabilities', {
  method: 'GET',
  handler: createVoiceCapabilitiesHandler({ speechAvailable: Boolean(speechAdapter) }) as Parameters<
    typeof registerApiRoute<'/voice/capabilities'>
  >[1]['handler'],
});

export const voiceSpeechRoute = registerApiRoute('/voice/speech', {
  method: 'POST',
  middleware: [createVoiceBodyLimit()] as unknown as Parameters<
    typeof registerApiRoute<'/voice/speech'>
  >[1]['middleware'],
  handler: createVoiceSpeechHandler({ adapter: speechAdapter }) as Parameters<
    typeof registerApiRoute<'/voice/speech'>
  >[1]['handler'],
});
