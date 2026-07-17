import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AnswerTranscriptionController,
  type RealtimeTranscriptionHandlers,
  type RealtimeTranscriptionSession,
} from './answerTranscriptionController';

function realtimeDouble() {
  let handlers: RealtimeTranscriptionHandlers | undefined;
  const commit = vi.fn();
  const mute = vi.fn();
  const close = vi.fn();
  const session: RealtimeTranscriptionSession = { commit, mute, close };
  const connect = vi.fn((options: { handlers: RealtimeTranscriptionHandlers }) => {
    handlers = options.handlers;
    return session;
  });
  return {
    client: { connect },
    session,
    connect,
    commit,
    mute,
    close,
    handlers: () => handlers,
  };
}

describe('AnswerTranscriptionController', () => {
  afterEach(() => vi.useRealTimers());

  it('does nothing before Start, then keeps committed words stable while partial text revises', async () => {
    const token = vi.fn(async () => 'sutkn_one-use');
    const realtime = realtimeDouble();
    const controller = new AnswerTranscriptionController({
      getToken: token,
      realtime: realtime.client,
    });

    expect(token).not.toHaveBeenCalled();
    expect(realtime.client.connect).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', text: '' });

    await controller.start('Typed opening.');
    expect(token).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().phase).toBe('connecting');

    realtime.handlers()?.onSessionStarted();
    realtime.handlers()?.onPartial('I led');
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'listening',
      text: 'Typed opening. I led',
    });

    realtime.handlers()?.onPartial('I led the migration');
    expect(controller.getSnapshot().text).toBe('Typed opening. I led the migration');

    realtime.handlers()?.onCommitted('I led the migration.');
    realtime.handlers()?.onPartial('It reduced');
    expect(controller.getSnapshot().text).toBe(
      'Typed opening. I led the migration. It reduced',
    );
  });

  it('stops capture, waits for the final commit, and leaves the transcript editable', async () => {
    const realtime = realtimeDouble();
    const controller = new AnswerTranscriptionController({
      getToken: vi.fn(async () => 'sutkn_one-use'),
      realtime: realtime.client,
    });
    await controller.start('');
    realtime.handlers()?.onSessionStarted();
    realtime.handlers()?.onPartial('I led the migration');

    controller.stop();
    expect(controller.getSnapshot().phase).toBe('finalizing');
    expect(realtime.session.mute).toHaveBeenCalledOnce();
    expect(realtime.session.commit).toHaveBeenCalledOnce();
    expect(realtime.session.close).not.toHaveBeenCalled();

    realtime.handlers()?.onCommitted('I led the migration.');
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'stopped',
      text: 'I led the migration.',
      status: 'Dictation stopped. Review your answer before delivering.',
    });
    expect(realtime.session.close).toHaveBeenCalledOnce();
    realtime.handlers()?.onPartial('late overwrite');
    expect(controller.getSnapshot().text).toBe('I led the migration.');
  });

  it('bounds finalization, retains the draft, and allows an explicit retry after failure', async () => {
    vi.useFakeTimers();
    const realtime = realtimeDouble();
    const getToken = vi.fn(async () => 'sutkn_one-use');
    const controller = new AnswerTranscriptionController({
      getToken,
      realtime: realtime.client,
      finalizationTimeoutMs: 1_000,
    });
    await controller.start('');
    realtime.handlers()?.onSessionStarted();
    realtime.handlers()?.onPartial('Draft words');
    controller.stop();

    vi.advanceTimersByTime(1_000);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'failed',
      text: 'Draft words',
      status: 'Dictation could not finalize. Your draft is still editable.',
    });
    expect(realtime.session.close).toHaveBeenCalledOnce();

    await controller.start(controller.getSnapshot().text);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'connecting', text: 'Draft words' });
  });

  it('updates elapsed time, auto-stops at the cap, and clears every timer and connection on abort', async () => {
    vi.useFakeTimers();
    const realtime = realtimeDouble();
    const controller = new AnswerTranscriptionController({
      getToken: vi.fn(async () => 'sutkn_one-use'),
      realtime: realtime.client,
      maxDurationMs: 5_000,
    });
    await controller.start('');
    realtime.handlers()?.onSessionStarted();

    vi.advanceTimersByTime(2_000);
    expect(controller.getSnapshot().elapsedSeconds).toBe(2);
    vi.advanceTimersByTime(3_000);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'finalizing',
      elapsedSeconds: 5,
      status: 'Five-minute limit reached. Finalizing dictation…',
    });

    controller.abort();
    expect(realtime.session.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a pending token request and never opens late media after leaving', async () => {
    let resolveToken: ((token: string) => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    const token = new Promise<string>((resolve) => {
      resolveToken = resolve;
    });
    const realtime = realtimeDouble();
    const controller = new AnswerTranscriptionController({
      getToken: vi.fn<(signal: AbortSignal) => Promise<string>>((signal) => {
        requestSignal = signal;
        return token;
      }),
      realtime: realtime.client,
    });

    const starting = controller.start('browser draft');
    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', text: '' });
    resolveToken?.('sutkn_too-late');
    await starting;
    expect(realtime.client.connect).not.toHaveBeenCalled();
  });

  it('closes active media before delivery and ignores late realtime events', async () => {
    const realtime = realtimeDouble();
    const controller = new AnswerTranscriptionController({
      getToken: vi.fn(async () => 'sutkn_one-use'),
      realtime: realtime.client,
    });
    await controller.start('');
    realtime.handlers()?.onSessionStarted();
    realtime.handlers()?.onPartial('Reviewed answer');

    const answer = controller.prepareForDelivery();
    expect(answer).toBe('Reviewed answer');
    expect(realtime.session.close).toHaveBeenCalledOnce();
    realtime.handlers()?.onPartial('late overwrite');
    expect(controller.getSnapshot().text).toBe('Reviewed answer');
  });
});
