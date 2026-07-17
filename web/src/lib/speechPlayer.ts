import {
  voiceSpeechChunkSchema,
  type VoiceSpeechChunk,
} from '../../../shared/voice-contract';

export interface CaptionCue {
  atMs: number;
  count: number;
}

/** Clamp one segment's provider timing so captions can only advance. */
export function normalizeCaptionCues(
  alignment: VoiceSpeechChunk['alignment'],
  priorCount: number,
  textLength: number,
): CaptionCue[] {
  let atMs = 0;
  return alignment.characters.map((_character, index) => {
    atMs = Math.max(atMs, alignment.startsMs[index] ?? atMs);
    return {
      atMs,
      count: Math.min(textLength, priorCount + index + 1),
    };
  });
}

export interface AudioHandle {
  addEventListener(type: 'ended' | 'error', listener: () => void): void;
  removeEventListener(type: 'ended' | 'error', listener: () => void): void;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: 'src'): void;
  load(): void;
}

export interface SpeakQuestionOptions {
  text: string;
  onProgress: (prefix: string) => void;
  onPlaybackStart?: () => void;
  signal: AbortSignal;
}

export interface SpeechPlayer {
  speak(options: SpeakQuestionOptions): Promise<void>;
}

type TimerId = unknown;

export interface SpeechPlayerDependencies {
  fetchImpl?: typeof fetch;
  createAudio?: (url: string) => AudioHandle;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  setTimer?: (callback: () => void, delay: number) => TimerId;
  clearTimer?: (timer: TimerId) => void;
}

/** Fetch, reassemble, and play the app-owned timed speech stream. */
export function createSpeechPlayer({
  fetchImpl = fetch,
  createAudio = (url) => new Audio(url),
  createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: SpeechPlayerDependencies = {}): SpeechPlayer {
  return {
    async speak({ text, onProgress, onPlaybackStart, signal }) {
      const response = await fetchImpl('/voice/speech', {
        method: 'POST',
        headers: { accept: 'application/x-ndjson', 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
      });
      if (!response.ok || !response.body) throw new Error('Spoken delivery is unavailable.');

      const chunks: VoiceSpeechChunk[] = [];
      for await (const chunk of readSpeechChunks(response.body)) chunks.push(chunk);
      if (chunks.length === 0) throw new Error('Spoken delivery is unavailable.');

      const alignment = {
        characters: chunks.flatMap((chunk) => chunk.alignment.characters),
        startsMs: chunks.flatMap((chunk) => chunk.alignment.startsMs),
        endsMs: chunks.flatMap((chunk) => chunk.alignment.endsMs),
      };
      const cues = normalizeCaptionCues(alignment, 0, text.length);
      await playAudio();

      async function playAudio(): Promise<void> {
        if (signal.aborted) throw signal.reason;
        const blob = audioBlob(chunks.map((chunk) => chunk.audioBase64));
        const url = createObjectURL(blob);
        const audio = createAudio(url);
        const timers: TimerId[] = [];
        let settled = false;
        let rejectPlayback: (reason?: unknown) => void = () => undefined;
        let resolvePlayback: () => void = () => undefined;
        const finished = new Promise<void>((resolve, reject) => {
          resolvePlayback = resolve;
          rejectPlayback = reject;
        });
        const onEnded = () => {
          settled = true;
          resolvePlayback();
        };
        const onError = () => {
          settled = true;
          rejectPlayback(new Error('Audio playback failed.'));
        };
        const onAbort = () => {
          settled = true;
          rejectPlayback(signal.reason);
        };
        audio.addEventListener('ended', onEnded);
        audio.addEventListener('error', onError);
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          const playStarted = audio.play();
          await Promise.race([playStarted, finished]);
          if (settled) {
            await finished;
            return;
          }
          if (signal.aborted) throw signal.reason;
          onPlaybackStart?.();
          for (const cue of cues) {
            timers.push(
              setTimer(() => {
                if (!settled && !signal.aborted) onProgress(text.slice(0, cue.count));
              }, cue.atMs),
            );
          }
          await finished;
        } finally {
          settled = true;
          for (const timer of timers) clearTimer(timer);
          signal.removeEventListener('abort', onAbort);
          audio.removeEventListener('ended', onEnded);
          audio.removeEventListener('error', onError);
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
          revokeObjectURL(url);
        }
      }
    },
  };
}

async function* readSpeechChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<VoiceSpeechChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      buffered += decoder.decode(result.value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim()) yield parseSpeechLine(line);
        newline = buffered.indexOf('\n');
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) yield parseSpeechLine(buffered);
  } finally {
    reader.releaseLock();
  }
}

function parseSpeechLine(line: string): VoiceSpeechChunk {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('Spoken delivery is unavailable.');
  }
  const parsed = voiceSpeechChunkSchema.safeParse(value);
  if (!parsed.success) throw new Error('Spoken delivery is unavailable.');
  return parsed.data;
}

function audioBlob(segments: string[]): Blob {
  const parts: ArrayBuffer[] = [];
  try {
    for (const segment of segments) {
      const binary = atob(segment);
      parts.push(
        Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer,
      );
    }
  } catch {
    throw new Error('Spoken delivery is unavailable.');
  }
  return new Blob(parts, { type: 'audio/mpeg' });
}
