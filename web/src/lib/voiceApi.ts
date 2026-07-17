const CAPABILITY_TIMEOUT_MS = 3_000;
const TOKEN_TIMEOUT_MS = 8_000;

export interface VoiceCapabilities {
  speech: boolean;
  transcription: boolean;
}

export interface VoiceCapabilityOptions {
  fetchImpl?: typeof fetch;
  supportsPlayback?: () => boolean;
  supportsTranscription?: () => boolean;
  timeoutMs?: number;
}

/** Detect server voice readiness and the browser APIs each mode needs. */
export async function detectVoiceCapabilities({
  fetchImpl = fetch,
  supportsPlayback = supportsMp3Playback,
  supportsTranscription = supportsRealtimeTranscription,
  timeoutMs = CAPABILITY_TIMEOUT_MS,
}: VoiceCapabilityOptions = {}): Promise<VoiceCapabilities> {
  try {
    const response = await fetchImpl('/voice/capabilities', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return noVoiceCapabilities();
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return noVoiceCapabilities();
    }
    const value = body as Record<string, unknown>;
    if (typeof value.speech !== 'boolean' || typeof value.transcription !== 'boolean') {
      return noVoiceCapabilities();
    }
    return {
      speech: value.speech && supportsPlayback(),
      transcription: value.transcription && supportsTranscription(),
    };
  } catch {
    return noVoiceCapabilities();
  }
}

/** Compatibility helper for callers interested only in question playback. */
export async function detectQuestionSpeech(
  options: VoiceCapabilityOptions = {},
): Promise<boolean> {
  return (await detectVoiceCapabilities(options)).speech;
}

export interface TranscriptionTokenRequestOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Request a fresh single-use Scribe token. The token remains in browser memory only. */
export async function requestTranscriptionToken({
  fetchImpl = fetch,
  signal,
  timeoutMs = TOKEN_TIMEOUT_MS,
}: TranscriptionTokenRequestOptions = {}): Promise<string> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    const response = await fetchImpl('/voice/transcription-token', {
      method: 'POST',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: combinedSignal,
    });
    if (!response.ok) throw new Error('token status');
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('token response');
    }
    const token = (body as Record<string, unknown>).token;
    if (typeof token !== 'string' || token.length === 0) throw new Error('token response');
    return token;
  } catch {
    throw new Error('Dictation could not connect.');
  }
}

function noVoiceCapabilities(): VoiceCapabilities {
  return { speech: false, transcription: false };
}

function supportsMp3Playback(): boolean {
  if (typeof document === 'undefined') return false;
  return document.createElement('audio').canPlayType('audio/mpeg') !== '';
}

function supportsRealtimeTranscription(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const browser = window as unknown as Record<string, unknown>;
  const media = navigator.mediaDevices as unknown as Record<string, unknown> | undefined;
  return Boolean(
    media &&
      typeof media.getUserMedia === 'function' &&
      typeof browser.WebSocket === 'function' &&
      (typeof browser.AudioContext === 'function' ||
        typeof browser.webkitAudioContext === 'function'),
  );
}
