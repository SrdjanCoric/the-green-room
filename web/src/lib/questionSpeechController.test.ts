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
