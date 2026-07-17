import { z } from 'zod';

import type { TranscriptionTokenAdapter } from './voice-routes';

export const DEFAULT_TRANSCRIPTION_TOKEN_TIMEOUT_MS = 8_000;
const ELEVENLABS_TRANSCRIPTION_TOKEN_URL =
  'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe';

const tokenResponseSchema = z.object({ token: z.string().min(1) }).passthrough();

export class TranscriptionTokenProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'upstream' | 'timeout' | 'invalid-response',
  ) {
    super(message);
    this.name = 'TranscriptionTokenProviderError';
  }
}

export interface ElevenLabsTranscriptionTokenOptions {
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Build the server-only adapter that mints short-lived Scribe browser tokens. */
export function createElevenLabsTranscriptionTokenAdapter({
  apiKey,
  timeoutMs = DEFAULT_TRANSCRIPTION_TOKEN_TIMEOUT_MS,
  fetchImpl = fetch,
}: ElevenLabsTranscriptionTokenOptions): TranscriptionTokenAdapter {
  return {
    async create(signal) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
      let response: Response;
      try {
        response = await fetchImpl(ELEVENLABS_TRANSCRIPTION_TOKEN_URL, {
          method: 'POST',
          headers: { accept: 'application/json', 'xi-api-key': apiKey },
          signal: combinedSignal,
        });
      } catch (error) {
        if (timeoutSignal.aborted && !signal.aborted) {
          throw new TranscriptionTokenProviderError(
            'Transcription token creation timed out.',
            'timeout',
          );
        }
        if (signal.aborted) throw error;
        throw new TranscriptionTokenProviderError(
          'Transcription token creation failed.',
          'upstream',
        );
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new TranscriptionTokenProviderError(
          'Transcription token creation failed.',
          'upstream',
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new TranscriptionTokenProviderError(
          'Transcription token response was invalid.',
          'invalid-response',
        );
      }
      const parsed = tokenResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new TranscriptionTokenProviderError(
          'Transcription token response was invalid.',
          'invalid-response',
        );
      }
      return parsed.data.token;
    },
  };
}
