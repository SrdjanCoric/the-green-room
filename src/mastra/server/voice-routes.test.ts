import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { SpeechProviderError } from './elevenlabs-speech';
import { TranscriptionTokenProviderError } from './elevenlabs-transcription';
import {
  createTranscriptionTokenHandler,
  createVoiceBodyLimit,
  createVoiceCapabilitiesHandler,
  createVoiceSpeechHandler,
  MAX_SPEECH_CHARACTERS,
  voiceCapabilitiesRoute,
  voiceSpeechRoute,
  voiceTranscriptionTokenRoute,
  type SpeechAdapter,
  type TranscriptionTokenAdapter,
  type VoiceRouteContext,
} from './voice-routes';

function context(body?: unknown): { c: VoiceRouteContext; response: () => Response | undefined } {
  let captured: Response | undefined;
  return {
    c: {
      req: { json: async () => body },
      json: (data: unknown, status = 200) => {
        captured = new Response(JSON.stringify(data), {
          status,
          headers: { 'content-type': 'application/json' },
        });
        return captured;
      },
    },
    response: () => captured,
  };
}

describe('voice route wiring', () => {
  it('registers same-origin capability, speech, and transcription-token endpoints', () => {
    expect(voiceCapabilitiesRoute).toMatchObject({ path: '/voice/capabilities', method: 'GET' });
    expect(voiceSpeechRoute).toMatchObject({ path: '/voice/speech', method: 'POST' });
    expect(voiceTranscriptionTokenRoute).toMatchObject({
      path: '/voice/transcription-token',
      method: 'POST',
    });
    expect(voiceSpeechRoute.middleware).toBeDefined();
  });
});

describe('voice speech body limit', () => {
  it('stops an over-limit stream before the route handler', async () => {
    let handled = false;
    const app = new Hono();
    app.use('/voice/speech', createVoiceBodyLimit(8));
    app.post('/voice/speech', (c) => {
      handled = true;
      return c.json({ ok: true });
    });

    const response = await app.request('/voice/speech', {
      method: 'POST',
      headers: { 'content-length': '100' },
      body: '{}',
    });

    expect(response.status).toBe(413);
    expect(handled).toBe(false);
  });
});

describe('voice capability handler', () => {
  it('reports speech and transcription readiness independently', async () => {
    const enabled = context();
    createVoiceCapabilitiesHandler({ speechAvailable: true, transcriptionAvailable: false })(
      enabled.c,
    );

    expect(enabled.response()?.status).toBe(200);
    const enabledBody = (await enabled.response()?.json()) as unknown;
    expect(enabledBody).toEqual({ speech: true, transcription: false });
    expect(JSON.stringify(enabledBody)).not.toContain('secret-key');

    const inverse = context();
    createVoiceCapabilitiesHandler({ speechAvailable: false, transcriptionAvailable: true })(
      inverse.c,
    );
    expect((await inverse.response()?.json()) as unknown).toEqual({
      speech: false,
      transcription: true,
    });
  });
});

describe('voice transcription token handler', () => {
  it('returns one no-store token and does not disclose the server key', async () => {
    const adapter: TranscriptionTokenAdapter = {
      create: vi.fn(async () => 'sutkn_one-use'),
    };
    const request = context();

    const response = await createTranscriptionTokenHandler({ adapter })(request.c);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ token: 'sutkn_one-use' });
  });

  it('maps unavailable, upstream, and timeout failures without provider details', async () => {
    const cases = [
      { adapter: undefined, status: 503 },
      {
        adapter: {
          create: vi.fn(async () => {
            throw new TranscriptionTokenProviderError('server-secret was rejected', 'upstream');
          }),
        },
        status: 502,
      },
      {
        adapter: {
          create: vi.fn(async () => {
            throw new TranscriptionTokenProviderError('provider timed out', 'timeout');
          }),
        },
        status: 504,
      },
    ] satisfies { adapter: TranscriptionTokenAdapter | undefined; status: number }[];

    for (const testCase of cases) {
      const request = context();
      await createTranscriptionTokenHandler({ adapter: testCase.adapter })(request.c);
      expect(request.response()?.status).toBe(testCase.status);
      const body = (await request.response()?.json()) as unknown;
      expect(body).toEqual({ error: 'Dictation is unavailable.' });
      expect(JSON.stringify(body)).not.toContain('server-secret');
    }
  });
});

describe('voice speech handler', () => {
  it('rejects missing, empty, and over-limit question text before synthesis', async () => {
    const synthesize = vi.fn();
    const adapter: SpeechAdapter = { synthesize };
    const handler = createVoiceSpeechHandler({ adapter });

    for (const body of [undefined, {}, { text: '   ' }, { text: 'x'.repeat(MAX_SPEECH_CHARACTERS + 1) }]) {
      const invalid = context(body);
      await handler(invalid.c);
      expect(invalid.response()?.status).toBe(400);
    }

    expect(synthesize).not.toHaveBeenCalled();
  });

  it('streams normalized app-owned speech chunks as no-store NDJSON', async () => {
    const adapter: SpeechAdapter = {
      synthesize: vi.fn(async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              audioBase64: 'YXVkaW8=',
              alignment: { characters: ['H', 'i'], startsMs: [0, 100], endsMs: [100, 200] },
            });
            controller.close();
          },
        }),
      ),
    };
    const request = context({ text: 'Hi' });

    const response = await createVoiceSpeechHandler({ adapter })(request.c);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/x-ndjson/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(
      `${JSON.stringify({
        audioBase64: 'YXVkaW8=',
        alignment: { characters: ['H', 'i'], startsMs: [0, 100], endsMs: [100, 200] },
      })}\n`,
    );
  });

  it('returns a retryable service response when speech is not configured', async () => {
    const request = context({ text: 'Tell me about your work.' });

    await createVoiceSpeechHandler({ adapter: undefined })(request.c);

    expect(request.response()?.status).toBe(503);
    expect(await request.response()?.json()).toEqual({ error: 'Spoken delivery is unavailable.' });
  });

  it('maps provider failures and timeouts without exposing provider details', async () => {
    for (const [error, expectedStatus] of [
      [new SpeechProviderError('upstream said API key server-secret is invalid', 'upstream'), 502],
      [new SpeechProviderError('provider timeout', 'timeout'), 504],
    ] as const) {
      const adapter: SpeechAdapter = {
        synthesize: vi.fn(async () => {
          throw error;
        }),
      };
      const request = context({ text: 'Tell me about your work.' });

      await createVoiceSpeechHandler({ adapter })(request.c);

      expect(request.response()?.status).toBe(expectedStatus);
      const body = (await request.response()?.json()) as unknown;
      expect(body).toEqual({ error: 'Spoken delivery is unavailable.' });
      expect(JSON.stringify(body)).not.toContain('server-secret');
    }
  });
});
