export type AnswerTranscriptionPhase =
  | 'ready'
  | 'connecting'
  | 'listening'
  | 'finalizing'
  | 'stopped'
  | 'failed';

export interface AnswerTranscriptionSnapshot {
  phase: AnswerTranscriptionPhase;
  text: string;
  elapsedSeconds: number;
  canContinue: boolean;
  status: string;
}

export interface RealtimeTranscriptionHandlers {
  onSessionStarted: () => void;
  onPartial: (text: string) => void;
  onCommitted: (text: string) => void;
  onError: () => void;
  onClose: () => void;
}

export interface RealtimeTranscriptionSession {
  commit(this: void): void;
  mute(this: void): void;
  close(this: void): void;
}

export interface RealtimeTranscriptionClient {
  connect(options: {
    token: string;
    handlers: RealtimeTranscriptionHandlers;
  }): RealtimeTranscriptionSession | Promise<RealtimeTranscriptionSession>;
}

export interface TranscriptionClock {
  now(): number;
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(id: ReturnType<typeof setInterval>): void;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}

export interface AnswerTranscriptionControllerOptions {
  getToken: (signal: AbortSignal) => Promise<string>;
  realtime: RealtimeTranscriptionClient;
  clock?: TranscriptionClock;
  maxDurationMs?: number;
  finalizationTimeoutMs?: number;
}

const FIVE_MINUTES_MS = 5 * 60 * 1_000;
const FINALIZATION_TIMEOUT_MS = 5_000;
const initialSnapshot: AnswerTranscriptionSnapshot = {
  phase: 'ready',
  text: '',
  elapsedSeconds: 0,
  canContinue: true,
  status: 'Ready to dictate.',
};
const systemClock: TranscriptionClock = {
  now: () => Date.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (id) => clearInterval(id),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id),
};

/** Owns one dictated answer and the isolated realtime resources for its active segment. */
export class AnswerTranscriptionController {
  readonly #getToken: (signal: AbortSignal) => Promise<string>;
  readonly #realtime: RealtimeTranscriptionClient;
  readonly #clock: TranscriptionClock;
  readonly #maxDurationMs: number;
  readonly #finalizationTimeoutMs: number;
  readonly #listeners = new Set<() => void>();
  #snapshot = initialSnapshot;
  #baseText = '';
  #committed: string[] = [];
  #partial = '';
  #abort: AbortController | null = null;
  #session: RealtimeTranscriptionSession | null = null;
  #attempt = 0;
  #completedSegments = 0;
  #recordedMs = 0;
  #startedAt: number | null = null;
  #elapsedTimer: ReturnType<typeof setInterval> | null = null;
  #durationTimer: ReturnType<typeof setTimeout> | null = null;
  #finalizationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor({
    getToken,
    realtime,
    clock = systemClock,
    maxDurationMs = FIVE_MINUTES_MS,
    finalizationTimeoutMs = FINALIZATION_TIMEOUT_MS,
  }: AnswerTranscriptionControllerOptions) {
    this.#getToken = getToken;
    this.#realtime = realtime;
    this.#clock = clock;
    this.#maxDurationMs = maxDurationMs;
    this.#finalizationTimeoutMs = finalizationTimeoutMs;
  }

  getSnapshot = (): AnswerTranscriptionSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async start(baseText: string): Promise<void> {
    if (
      this.#snapshot.phase === 'connecting' ||
      this.#snapshot.phase === 'listening' ||
      this.#snapshot.phase === 'finalizing' ||
      this.#recordedMs >= this.#maxDurationMs
    ) {
      return;
    }
    this.#releaseResources();
    const attempt = ++this.#attempt;
    this.#baseText = baseText.trim();
    this.#committed = [];
    this.#partial = '';
    const requestAbort = new AbortController();
    this.#abort = requestAbort;
    this.#set({
      phase: 'connecting',
      text: this.#baseText,
      elapsedSeconds: this.#elapsedSeconds(),
      canContinue: true,
      status: 'Connecting to dictation…',
    });

    try {
      const token = await this.#getToken(requestAbort.signal);
      if (attempt !== this.#attempt || requestAbort.signal.aborted) return;
      const session = await this.#realtime.connect({
        token,
        handlers: {
          onSessionStarted: () => this.#beginListening(attempt),
          onPartial: (text) => {
            if (!this.#isCurrent(attempt)) return;
            this.#partial = text.trim();
            this.#publishText();
          },
          onCommitted: (text) => this.#commitTranscript(attempt, text),
          onError: () => {
            if (this.#isCurrent(attempt)) {
              this.#fail('Dictation was interrupted. Your draft is still editable.');
            }
          },
          onClose: () => {
            if (this.#isCurrent(attempt) && this.#session) {
              this.#fail('Dictation was interrupted. Your draft is still editable.');
            }
          },
        },
      });
      if (attempt !== this.#attempt || requestAbort.signal.aborted) {
        session.close();
        return;
      }
      this.#session = session;
    } catch {
      if (attempt !== this.#attempt || requestAbort.signal.aborted) return;
      this.#fail('Dictation could not connect.');
    }
  }

  stop(reason: 'explicit' | 'limit' = 'explicit'): void {
    if (this.#snapshot.phase !== 'listening' || !this.#session) return;
    this.#finishCapture();
    this.#clearCaptureTimers();
    this.#set({
      ...this.#snapshot,
      phase: 'finalizing',
      status:
        reason === 'limit'
          ? 'Five-minute limit reached. Finalizing dictation…'
          : 'Finalizing dictation…',
    });
    try {
      // The ElevenLabs browser client replaces the live track with silence while the
      // final manual commit is processed. Closing below releases every media track.
      this.#session.mute();
      this.#session.commit();
      this.#finalizationTimer = this.#clock.setTimeout(
        () => this.#fail('Dictation could not finalize. Your draft is still editable.'),
        this.#finalizationTimeoutMs,
      );
    } catch {
      this.#fail('Dictation could not finalize. Your draft is still editable.');
    }
  }

  abort(): void {
    ++this.#attempt;
    this.#releaseResources();
    this.#resetAnswerState();
    this.#set(initialSnapshot);
  }

  prepareForDelivery(): string {
    const text = this.#snapshot.text;
    ++this.#attempt;
    this.#releaseResources();
    this.#resetAnswerState();
    this.#set({ ...this.#snapshot, phase: 'stopped', text, elapsedSeconds: 0 });
    return text;
  }

  #beginListening(attempt: number): void {
    if (!this.#isCurrent(attempt) || this.#snapshot.phase !== 'connecting') return;
    this.#startedAt = this.#clock.now();
    this.#set({ ...this.#snapshot, phase: 'listening', status: 'Listening…' });
    this.#elapsedTimer = this.#clock.setInterval(() => this.#updateElapsed(), 1_000);
    this.#durationTimer = this.#clock.setTimeout(
      () => this.stop('limit'),
      this.#maxDurationMs - this.#recordedMs,
    );
  }

  #commitTranscript(attempt: number, text: string): void {
    if (!this.#isCurrent(attempt)) return;
    const committed = text.trim();
    if (committed) {
      this.#committed.push(committed);
      this.#partial = '';
    }
    this.#publishText();
    if (this.#snapshot.phase === 'finalizing') {
      this.#clearFinalizationTimer();
      this.#closeSession();
      ++this.#attempt;
      ++this.#completedSegments;
      this.#set({
        ...this.#snapshot,
        phase: 'stopped',
        status: 'Dictation stopped. Review your answer before delivering.',
      });
    }
  }

  #updateElapsed(): void {
    const elapsedSeconds = this.#elapsedSeconds();
    if (elapsedSeconds !== this.#snapshot.elapsedSeconds) {
      this.#set({ ...this.#snapshot, elapsedSeconds });
    }
  }

  #finishCapture(): void {
    if (this.#startedAt === null) return;
    this.#recordedMs = this.#elapsedMs();
    this.#startedAt = null;
    this.#updateElapsed();
  }

  #elapsedSeconds(): number {
    return Math.floor(this.#elapsedMs() / 1_000);
  }

  #elapsedMs(): number {
    const activeMs =
      this.#startedAt === null ? 0 : Math.max(0, this.#clock.now() - this.#startedAt);
    return Math.min(this.#recordedMs + activeMs, this.#maxDurationMs);
  }

  #publishText(): void {
    this.#set({
      ...this.#snapshot,
      text: joinText(this.#baseText, ...this.#committed, this.#partial),
    });
  }

  #fail(status: string): void {
    ++this.#attempt;
    this.#finishCapture();
    this.#clearTimers();
    this.#closeSession();
    this.#abort?.abort();
    this.#abort = null;
    if (this.#completedSegments > 0) {
      this.#committed = [];
      this.#partial = '';
    }
    this.#set({
      ...this.#snapshot,
      phase: 'failed',
      text: this.#completedSegments > 0 ? this.#baseText : this.#snapshot.text,
      status,
    });
  }

  #resetAnswerState(): void {
    this.#baseText = '';
    this.#committed = [];
    this.#partial = '';
    this.#completedSegments = 0;
    this.#recordedMs = 0;
    this.#startedAt = null;
  }

  #releaseResources(): void {
    this.#abort?.abort();
    this.#abort = null;
    this.#clearTimers();
    this.#closeSession();
  }

  #closeSession(): void {
    const session = this.#session;
    this.#session = null;
    session?.close();
  }

  #clearCaptureTimers(): void {
    if (this.#elapsedTimer) this.#clock.clearInterval(this.#elapsedTimer);
    if (this.#durationTimer) this.#clock.clearTimeout(this.#durationTimer);
    this.#elapsedTimer = null;
    this.#durationTimer = null;
  }

  #clearFinalizationTimer(): void {
    if (this.#finalizationTimer) this.#clock.clearTimeout(this.#finalizationTimer);
    this.#finalizationTimer = null;
  }

  #clearTimers(): void {
    this.#clearCaptureTimers();
    this.#clearFinalizationTimer();
  }

  #isCurrent(attempt: number): boolean {
    return attempt === this.#attempt;
  }

  #set(snapshot: AnswerTranscriptionSnapshot): void {
    this.#snapshot = {
      ...snapshot,
      canContinue: this.#elapsedMs() < this.#maxDurationMs,
    };
    for (const listener of this.#listeners) listener();
  }
}

function joinText(...parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
}
