import type { SpeechPlayer } from './speechPlayer';

export interface QuestionSpeechRequest {
  id: string;
  text: string;
  onProgress: (prefix: string) => void;
  onPlaybackStart?: () => void;
}

interface ActiveSpeech {
  id: string;
  abort: AbortController;
  request: QuestionSpeechRequest;
  promise: Promise<void>;
}

/**
 * Owns one browser utterance at a time and remembers every attempted utterance id.
 * Exact rerenders share one promise; a replacement id aborts stale audio first.
 */
export class QuestionSpeechController {
  readonly #attempted = new Set<string>();
  readonly #player: SpeechPlayer;
  #active: ActiveSpeech | null = null;
  #pendingRelease: { id: string; token: object } | null = null;

  constructor(player: SpeechPlayer) {
    this.#player = player;
  }

  speak(request: QuestionSpeechRequest): Promise<void> {
    if (this.#pendingRelease?.id === request.id) this.#pendingRelease = null;
    if (this.#active?.id === request.id) {
      // StrictMode remounts the effect while the same player promise is active. Hand
      // progress to the current effect rather than leaving callbacks on the released one.
      this.#active.request = request;
      return this.#active.promise;
    }
    if (this.#active) this.#active.abort.abort(abortReason());
    if (this.#attempted.has(request.id)) return Promise.resolve();

    this.#attempted.add(request.id);
    const abort = new AbortController();
    const active: ActiveSpeech = {
      id: request.id,
      abort,
      request,
      promise: Promise.resolve(),
    };
    this.#active = active;
    active.promise = this.#player
      .speak({
        text: request.text,
        onProgress: (prefix) => active.request.onProgress(prefix),
        onPlaybackStart: () => active.request.onPlaybackStart?.(),
        signal: abort.signal,
      })
      .finally(() => {
        if (this.#active === active) this.#active = null;
      });
    return active.promise;
  }

  /**
   * Release from a React effect. Deferring one microtask lets StrictMode's immediate
   * setup reuse the in-flight request instead of cancelling and rebilling it.
   */
  release(id: string): void {
    const token = {};
    this.#pendingRelease = { id, token };
    queueMicrotask(() => {
      if (this.#pendingRelease?.token !== token) return;
      this.#pendingRelease = null;
      if (this.#active?.id === id) this.#active.abort.abort(abortReason());
    });
  }

  cancel(): void {
    this.#pendingRelease = null;
    this.#active?.abort.abort(abortReason());
    this.#active = null;
  }
}

function abortReason(): DOMException {
  return new DOMException('Spoken delivery was cancelled.', 'AbortError');
}
