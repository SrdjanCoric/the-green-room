import { describe, expect, it, vi } from 'vitest';

import { createSpeechPlayer, normalizeCaptionCues, type AudioHandle } from './speechPlayer';

describe('speech caption timing', () => {
  it('turns provider character starts into monotonic prefix cues', () => {
    expect(
      normalizeCaptionCues(
        {
          characters: ['W', 'o', 'w'],
          startsMs: [0, 120, 80],
          endsMs: [100, 220, 180],
        },
        4,
        10,
      ),
    ).toEqual([
      { atMs: 0, count: 5 },
      { atMs: 120, count: 6 },
      { atMs: 120, count: 7 },
    ]);
  });

  it('plays normalized NDJSON audio and advances the real text from alignment cues', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        `${JSON.stringify({
          audioBase64: 'YXVkaW8=',
          alignment: { characters: ['H', 'i'], startsMs: [0, 120], endsMs: [120, 240] },
        })}\n`,
        { status: 200 },
      ),
    );
    const timers: { callback: () => void; delay: number }[] = [];
    const listeners = new Map<string, () => void>();
    const play = vi.fn(async () => undefined);
    const audio: AudioHandle = {
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type) => listeners.delete(type),
      play,
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    };
    const revokeObjectURL = vi.fn();
    const onProgress = vi.fn<(prefix: string) => void>();
    const onPlaybackStart = vi.fn();
    const player = createSpeechPlayer({
      fetchImpl: fetchImpl,
      createAudio: () => audio,
      createObjectURL: () => 'blob:question',
      revokeObjectURL,
      setTimer: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimer: vi.fn(),
    });

    const speaking = player.speak({
      text: 'Hi',
      onProgress,
      onPlaybackStart,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(timers).toHaveLength(2));
    for (const timer of [...timers].sort((a, b) => a.delay - b.delay)) timer.callback();
    listeners.get('ended')?.();
    await speaking;

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(onPlaybackStart).toHaveBeenCalledOnce();
    expect(onProgress.mock.calls.map((call) => call[0])).toEqual(['H', 'Hi']);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:question');
  });

  it('reassembles segmented MP3 data before starting one continuous playback', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        [
          JSON.stringify({
            audioBase64: 'YQ==',
            alignment: { characters: ['H'], startsMs: [0], endsMs: [100] },
          }),
          JSON.stringify({
            audioBase64: 'Yg==',
            alignment: { characters: [], startsMs: [], endsMs: [] },
          }),
        ].join('\n') + '\n',
        { status: 200 },
      ),
    );
    const listeners = new Map<string, () => void>();
    const play = vi.fn(async () => {
      queueMicrotask(() => listeners.get('ended')?.());
    });
    const audio: AudioHandle = {
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type) => listeners.delete(type),
      play,
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    };
    const createAudio = vi.fn(() => audio);
    const createObjectURL = vi.fn((blob: Blob) => {
      expect(blob.size).toBe(2);
      return 'blob:joined-question';
    });
    const player = createSpeechPlayer({
      fetchImpl,
      createAudio,
      createObjectURL,
      revokeObjectURL: vi.fn(),
      setTimer: (callback) => {
        callback();
        return 1;
      },
      clearTimer: vi.fn(),
    });

    await player.speak({
      text: 'H',
      onProgress: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createAudio).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();
  });

  it('stops playback and releases audio resources when the utterance is aborted', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        `${JSON.stringify({
          audioBase64: 'YXVkaW8=',
          alignment: { characters: ['H'], startsMs: [500], endsMs: [600] },
        })}\n`,
        { status: 200 },
      ),
    );
    const listeners = new Map<string, () => void>();
    const play = vi.fn(() => new Promise<void>(() => undefined));
    const pause = vi.fn();
    const removeAttribute = vi.fn();
    const load = vi.fn();
    const audio: AudioHandle = {
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type) => listeners.delete(type),
      play,
      pause,
      removeAttribute,
      load,
    };
    const clearTimer = vi.fn();
    const revokeObjectURL = vi.fn();
    const player = createSpeechPlayer({
      fetchImpl: fetchImpl,
      createAudio: () => audio,
      createObjectURL: () => 'blob:question',
      revokeObjectURL,
      setTimer: () => 17,
      clearTimer,
    });
    const abort = new AbortController();
    const speaking = player.speak({ text: 'H', onProgress: vi.fn(), signal: abort.signal });
    await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());

    abort.abort(new DOMException('page unloaded', 'AbortError'));

    await expect(speaking).rejects.toMatchObject({ name: 'AbortError' });
    expect(pause).toHaveBeenCalledOnce();
    expect(removeAttribute).toHaveBeenCalledWith('src');
    expect(load).toHaveBeenCalledOnce();
    expect(clearTimer).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:question');
  });
});
