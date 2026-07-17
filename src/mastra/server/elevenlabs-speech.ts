import { z } from 'zod';

import {
  voiceSpeechChunkSchema,
  type VoiceSpeechChunk,
} from '../../../shared/voice-contract';
import type { SpeechAdapter } from './voice-routes';

/** Bella: a premade English voice labeled professional, bright, and warm. */
export const DEFAULT_ELEVENLABS_VOICE_ID = 'hpp4J3VqNfWAUOO0d1Us';
/** ElevenLabs' current lowest-latency multilingual TTS model. */
export const DEFAULT_ELEVENLABS_MODEL = 'eleven_flash_v2_5';
export const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';
export const DEFAULT_SPEECH_TIMEOUT_MS = 15_000;

const providerAlignmentSchema = z
  .object({
    characters: z.array(z.string()),
    character_start_times_seconds: z.array(z.number().finite().nonnegative()),
    character_end_times_seconds: z.array(z.number().finite().nonnegative()),
  })
  .strict();

const providerChunkSchema = z
  .object({
    audio_base64: z.string().min(1),
    alignment: providerAlignmentSchema.nullable().optional(),
  })
  .passthrough();

export class SpeechProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'upstream' | 'timeout' | 'invalid-response',
  ) {
    super(message);
    this.name = 'SpeechProviderError';
  }
}

export interface ElevenLabsSpeechOptions {
  apiKey: string;
  voiceId?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Build the server-only ElevenLabs adapter. It translates the provider's streamed
 * snake-case JSON into the small app-owned contract consumed by the browser.
 */
export function createElevenLabsSpeechAdapter({
  apiKey,
  voiceId = DEFAULT_ELEVENLABS_VOICE_ID,
  model = DEFAULT_ELEVENLABS_MODEL,
  timeoutMs = DEFAULT_SPEECH_TIMEOUT_MS,
  fetchImpl = fetch,
}: ElevenLabsSpeechOptions): SpeechAdapter {
  return {
    async synthesize(text, signal) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
      let response: Response;
      try {
        response = await fetchImpl(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream/with-timestamps?output_format=${ELEVENLABS_OUTPUT_FORMAT}`,
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              'xi-api-key': apiKey,
            },
            body: JSON.stringify({ text, model_id: model }),
            signal: combinedSignal,
          },
        );
      } catch (error) {
        if (timeoutSignal.aborted && !signal.aborted) {
          throw new SpeechProviderError('Speech generation timed out.', 'timeout');
        }
        if (signal.aborted) throw error;
        throw new SpeechProviderError('Speech generation failed.', 'upstream');
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SpeechProviderError('Speech generation failed.', 'upstream');
      }
      if (!response.body) {
        throw new SpeechProviderError('Speech response had no body.', 'invalid-response');
      }

      return parseProviderStream(response.body);
    },
  };
}

function parseProviderStream(
  body: ReadableStream<Uint8Array>,
): ReadableStream<VoiceSpeechChunk> {
  const decoder = new TextDecoder();
  let buffered = '';
  return new ReadableStream<VoiceSpeechChunk>({
    async start(controller) {
      const reader = body.getReader();
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          buffered += decoder.decode(result.value, { stream: true });
          emitCompleteLines(controller);
        }
        buffered += decoder.decode();
        if (buffered.trim()) emitLine(controller, buffered);
        controller.close();
      } catch (error) {
        controller.error(
          error instanceof SpeechProviderError
            ? error
            : new SpeechProviderError('Speech response was invalid.', 'invalid-response'),
        );
      } finally {
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      await body.cancel(reason);
    },
  });

  function emitCompleteLines(controller: ReadableStreamDefaultController<VoiceSpeechChunk>) {
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim()) emitLine(controller, line);
    }
  }
}

function emitLine(
  controller: ReadableStreamDefaultController<VoiceSpeechChunk>,
  line: string,
): void {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new SpeechProviderError('Speech response was invalid.', 'invalid-response');
  }
  const parsed = providerChunkSchema.safeParse(value);
  if (!parsed.success) {
    throw new SpeechProviderError('Speech response was invalid.', 'invalid-response');
  }
  const alignment = parsed.data.alignment ?? {
    characters: [],
    character_start_times_seconds: [],
    character_end_times_seconds: [],
  };
  const normalized = voiceSpeechChunkSchema.safeParse({
    audioBase64: parsed.data.audio_base64,
    alignment: {
      characters: alignment.characters,
      startsMs: alignment.character_start_times_seconds.map(secondsToMilliseconds),
      endsMs: alignment.character_end_times_seconds.map(secondsToMilliseconds),
    },
  });
  if (!normalized.success) {
    throw new SpeechProviderError('Speech response was invalid.', 'invalid-response');
  }
  controller.enqueue(normalized.data);
}

function secondsToMilliseconds(seconds: number): number {
  return Math.round(seconds * 1_000);
}
