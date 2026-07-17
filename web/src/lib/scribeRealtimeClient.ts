import type { RealtimeConnection, RealtimeEvents } from '@elevenlabs/client';

import type {
  RealtimeTranscriptionClient,
  RealtimeTranscriptionHandlers,
  RealtimeTranscriptionSession,
} from './answerTranscriptionController';

/** Connect Scribe's browser microphone mode to the app-owned controller boundary. */
export function createScribeRealtimeClient(): RealtimeTranscriptionClient {
  return {
    async connect({ token, handlers }): Promise<RealtimeTranscriptionSession> {
      // Scribe brings its browser audio pipeline only when the candidate starts
      // dictating, instead of adding it to the interview's initial page bundle.
      const { CommitStrategy, RealtimeEvents: Events, Scribe } = await import(
        '@elevenlabs/client'
      );
      const connection = Scribe.connect({
        token,
        modelId: 'scribe_v2_realtime',
        commitStrategy: CommitStrategy.MANUAL,
        microphone: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      attachHandlers(connection, Events, handlers);
      return {
        commit: () => connection.commit(),
        mute: () => connection.mute(),
        close: () => connection.close(),
      };
    },
  };
}

function attachHandlers(
  connection: RealtimeConnection,
  events: typeof RealtimeEvents,
  handlers: RealtimeTranscriptionHandlers,
): void {
  connection.on(events.SESSION_STARTED, handlers.onSessionStarted);
  connection.on(events.PARTIAL_TRANSCRIPT, ({ text }) => handlers.onPartial(text));
  connection.on(events.COMMITTED_TRANSCRIPT, ({ text }) => handlers.onCommitted(text));
  connection.on(events.ERROR, handlers.onError);
  connection.on(events.CLOSE, handlers.onClose);
}
