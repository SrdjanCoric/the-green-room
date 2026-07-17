import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('@elevenlabs/client', () => ({
  Scribe: { connect: sdk.connect },
  CommitStrategy: { MANUAL: 'manual' },
  RealtimeEvents: {
    SESSION_STARTED: 'session_started',
    PARTIAL_TRANSCRIPT: 'partial_transcript',
    COMMITTED_TRANSCRIPT: 'committed_transcript',
    ERROR: 'error',
    CLOSE: 'close',
  },
}));

import { createScribeRealtimeClient } from './scribeRealtimeClient';

describe('Scribe realtime client', () => {
  beforeEach(() => sdk.connect.mockReset());

  it('streams the browser microphone directly with Scribe v2 and maps realtime events', async () => {
    const listeners = new Map<string, (data?: { text: string }) => void>();
    const connection = {
      on: vi.fn((event: string, listener: (data?: { text: string }) => void) => {
        listeners.set(event, listener);
      }),
      commit: vi.fn(),
      mute: vi.fn(),
      close: vi.fn(),
    };
    sdk.connect.mockReturnValue(connection);
    const handlers = {
      onSessionStarted: vi.fn(),
      onPartial: vi.fn(),
      onCommitted: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
    };

    const session = await createScribeRealtimeClient().connect({ token: 'sutkn_one-use', handlers });

    expect(sdk.connect).toHaveBeenCalledExactlyOnceWith({
      token: 'sutkn_one-use',
      modelId: 'scribe_v2_realtime',
      commitStrategy: 'manual',
      microphone: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    listeners.get('session_started')?.();
    listeners.get('partial_transcript')?.({ text: 'live revision' });
    listeners.get('committed_transcript')?.({ text: 'final words' });
    listeners.get('error')?.();
    listeners.get('close')?.();
    expect(handlers.onSessionStarted).toHaveBeenCalledOnce();
    expect(handlers.onPartial).toHaveBeenCalledWith('live revision');
    expect(handlers.onCommitted).toHaveBeenCalledWith('final words');
    expect(handlers.onError).toHaveBeenCalledOnce();
    expect(handlers.onClose).toHaveBeenCalledOnce();

    session.mute();
    session.commit();
    session.close();
    expect(connection.mute).toHaveBeenCalledOnce();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
  });
});
