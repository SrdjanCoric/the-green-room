const CAPABILITY_TIMEOUT_MS = 3_000;

export interface VoiceCapabilityOptions {
  fetchImpl?: typeof fetch;
  supportsPlayback?: () => boolean;
  timeoutMs?: number;
}

/**
 * Check the same-origin server capability and this browser's MP3 playback support.
 * Detection is deliberately fail-closed: any problem leaves the typed interview intact.
 */
export async function detectQuestionSpeech({
  fetchImpl = fetch,
  supportsPlayback = supportsMp3Playback,
  timeoutMs = CAPABILITY_TIMEOUT_MS,
}: VoiceCapabilityOptions = {}): Promise<boolean> {
  if (!supportsPlayback()) return false;
  try {
    const response = await fetchImpl('/voice/capabilities', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return (
      typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).speech === true
    );
  } catch {
    return false;
  }
}

function supportsMp3Playback(): boolean {
  if (typeof document === 'undefined') return false;
  const audio = document.createElement('audio');
  return audio.canPlayType('audio/mpeg') !== '';
}
