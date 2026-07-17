import { describe, expect, it, vi } from 'vitest';

import { QuestionSpeechController } from './questionSpeechController';
import type { SpeakQuestionOptions, SpeechPlayer } from './speechPlayer';

describe('QuestionSpeechController', () => {
  it('makes at most one speech request for an utterance across repeated renders', async () => {
    const speak = vi.fn(async (options: SpeakQuestionOptions) => {
      void options;
    });
    const player: SpeechPlayer = { speak };
    const controller = new QuestionSpeechController(player);
    const request = { id: 'run-1:1:Question?', text: 'Question?', onProgress: vi.fn() };

    await Promise.all([controller.speak(request), controller.speak(request), controller.speak(request)]);

    expect(speak).toHaveBeenCalledOnce();
  });

  it('hands an in-flight utterance to a StrictMode remount without a second request', async () => {
    let emitProgress: ((prefix: string) => void) | undefined;
    let finish: (() => void) | undefined;
    const speak = vi.fn(
      ({ onProgress }: SpeakQuestionOptions) =>
        new Promise<void>((resolve) => {
          emitProgress = onProgress;
          finish = resolve;
        }),
    );
    const controller = new QuestionSpeechController({ speak });
    const firstProgress = vi.fn();
    const currentProgress = vi.fn();

    void controller.speak({ id: 'run-1:closing', text: 'Thanks.', onProgress: firstProgress });
    controller.release('run-1:closing');
    const current = controller.speak({
      id: 'run-1:closing',
      text: 'Thanks.',
      onProgress: currentProgress,
    });
    emitProgress?.('Thanks');

    expect(speak).toHaveBeenCalledOnce();
    expect(firstProgress).not.toHaveBeenCalled();
    expect(currentProgress).toHaveBeenCalledWith('Thanks');
    finish?.();
    await current;
  });

  it('does not recreate an interrupted utterance after an actual remount', async () => {
    const speak = vi.fn(
      ({ signal }: SpeakQuestionOptions) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true },
          );
        }),
    );
    const controller = new QuestionSpeechController({ speak });
    const first = controller
      .speak({ id: 'run-1:closing', text: 'Thanks.', onProgress: vi.fn() })
      .catch(() => undefined);

    controller.release('run-1:closing');
    await Promise.resolve();
    await first;
    await controller.speak({ id: 'run-1:closing', text: 'Thanks.', onProgress: vi.fn() });

    expect(speak).toHaveBeenCalledOnce();
  });

  it('aborts stale playback and speaks a replacement utterance', async () => {
    const signals: AbortSignal[] = [];
    const speak = vi.fn(
      ({ signal }: SpeakQuestionOptions) =>
        new Promise<void>((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true },
          );
        }),
    );
    const player: SpeechPlayer = { speak };
    const controller = new QuestionSpeechController(player);
    const first = controller
      .speak({ id: 'run-1:2:first', text: 'First?', onProgress: vi.fn() })
      .catch(() => undefined);

    void controller
      .speak({ id: 'run-1:2:replacement', text: 'Replacement?', onProgress: vi.fn() })
      .catch(() => undefined);

    expect(signals[0]?.aborted).toBe(true);
    expect(speak).toHaveBeenCalledTimes(2);
    controller.cancel();
    await first;
  });
});
