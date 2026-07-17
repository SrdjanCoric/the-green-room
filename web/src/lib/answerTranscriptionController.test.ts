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

  it('preserves reviewed edits while a second segment revises and appends its active suffix', async () => {
    const realtime = realtimeDouble();
    const controller = new AnswerTranscriptionController({
      getToken: vi.fn(async () => 'sutkn_one-use'),
      realtime: realtime.client,
    });

    await controller.start('');
    realtime.handlers()?.onSessionStarted();
    controller.stop();
    realtime.handlers()?.onCommitted('I led the first migration.');

    const reviewed = 'I personally led the first migration.\nImpact: 40% faster.';
    await controller.start(reviewed);
    realtime.handlers()?.onSessionStarted();
    realtime.handlers()?.onPartial('Then I trained');
    expect(controller.getSnapshot().text).toBe(
      `${reviewed} Then I trained`,
    );

    realtime.handlers()?.onPartial('Then I trained five engineers');
    expect(controller.getSnapshot().text).toBe(
      `${reviewed} Then I trained five engineers`,
    );

    controller.stop();
    realtime.handlers()?.onCommitted('  Then I trained five engineers.  ');
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'stopped',
      text: `${reviewed} Then I trained five engineers.`,
    });
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

  it('discards a failed later segment without changing the reviewed answer', async () => {
    const realtime = realtimeDouble();
    const controller = new AnswerTranscriptionController({
      getToken: vi.fn(async () => 'sutkn_one-use'),
      realtime: realtime.client,
    });

    await controller.start('');
    realtime.handlers()?.onSessionStarted();
    controller.stop();
    realtime.handlers()?.onCommitted('First segment.');

    const reviewed = 'First segment, with my edit.';
    await controller.start(reviewed);
    realtime.handlers()?.onSessionStarted();
    realtime.handlers()?.onPartial('Words from a failing segment');
    realtime.handlers()?.onError();

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'failed',
      text: reviewed,
      status: 'Dictation was interrupted. Your draft is still editable.',
    });
    expect(controller.prepareForDelivery()).toBe(reviewed);
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

  it('requests a fresh token and closes the owned realtime connection for every segment', async () => {
    const handlers: RealtimeTranscriptionHandlers[] = [];
    const sessions: RealtimeTranscriptionSession[] = [];
    const connect = vi.fn(
      ({ handlers: nextHandlers }: { token: string; handlers: RealtimeTranscriptionHandlers }) => {
        handlers.push(nextHandlers);
        const session = { commit: vi.fn(), mute: vi.fn(), close: vi.fn() };
        sessions.push(session);
        return session;
      },
    );
    const getToken = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockResolvedValueOnce('sutkn_segment-1')
      .mockResolvedValueOnce('sutkn_segment-2');
    const controller = new AnswerTranscriptionController({
      getToken,
      realtime: { connect },
    });

    await controller.start('');
    handlers[0]?.onSessionStarted();
    controller.stop();
    handlers[0]?.onCommitted('First segment.');
    await controller.start('First segment.');
    handlers[1]?.onSessionStarted();
    controller.stop();
    handlers[1]?.onCommitted('Second segment.');

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls.map(([options]) => options.token)).toEqual([
      'sutkn_segment-1',
      'sutkn_segment-2',
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.close).toHaveBeenCalledOnce();
    expect(sessions[1]?.close).toHaveBeenCalledOnce();
  });

  it('carries elapsed recording time into the next segment and stops at the remaining limit', async () => {
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
    controller.stop();
    realtime.handlers()?.onCommitted('First segment.');
    expect(controller.getSnapshot().elapsedSeconds).toBe(2);

    await controller.start('First segment, reviewed.');
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'connecting',
      elapsedSeconds: 2,
      text: 'First segment, reviewed.',
    });
    realtime.handlers()?.onSessionStarted();
    vi.advanceTimersByTime(2_000);
    expect(controller.getSnapshot().elapsedSeconds).toBe(4);
    vi.advanceTimersByTime(1_000);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'finalizing',
      elapsedSeconds: 5,
      status: 'Five-minute limit reached. Finalizing dictation…',
    });
  });

  it('does not open another segment after the cumulative answer limit is exhausted', async () => {
    vi.useFakeTimers();
    const realtime = realtimeDouble();
    const getToken = vi.fn(async () => 'sutkn_one-use');
    const controller = new AnswerTranscriptionController({
      getToken,
      realtime: realtime.client,
      maxDurationMs: 1_000,
    });

    await controller.start('');
    realtime.handlers()?.onSessionStarted();
    vi.advanceTimersByTime(1_000);
    realtime.handlers()?.onCommitted('Answer at the limit.');
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'stopped',
      elapsedSeconds: 1,
      canContinue: false,
    });

    await controller.start('Answer at the limit.');
    expect(getToken).toHaveBeenCalledOnce();
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

  it('resets cumulative segment state after delivery before the next answer', async () => {
    vi.useFakeTimers();
    const realtime = realtimeDouble();
    const controller = new AnswerTranscriptionController({
      getToken: vi.fn(async () => 'sutkn_one-use'),
      realtime: realtime.client,
    });

    await controller.start('');
    realtime.handlers()?.onSessionStarted();
    vi.advanceTimersByTime(2_000);
    controller.stop();
    realtime.handlers()?.onCommitted('Delivered answer.');
    expect(controller.prepareForDelivery()).toBe('Delivered answer.');

    await controller.start('Typed opening for the next answer.');
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'connecting',
      text: 'Typed opening for the next answer.',
      elapsedSeconds: 0,
    });
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
