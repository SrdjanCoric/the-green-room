import { InMemoryServerCache } from '@mastra/core/cache';

/**
 * How long a run's cached stream chunks survive between pushes. The cache TTL slides
 * — every delivered chunk renews it — so this only has to outlast the quiet stretches
 * of an interview: a candidate thinking through an answer, a walk away from the desk.
 * The default (5 minutes) is built for chat-scale gaps and would forget the run
 * mid-interview; an hour comfortably covers a whole session.
 */
export const STREAM_REPLAY_TTL_MS = 60 * 60 * 1000;

/**
 * The chunk cache behind resumable streaming. The server records every workflow
 * stream chunk it delivers, keyed by run id; its observe endpoint replays them from
 * a client-supplied offset, which is how a reloaded browser rejoins an in-flight
 * interview stream. In-memory is the right scope here — the dev server is a single
 * process, and the run's durable state (the LibSQL snapshot) still covers a full
 * restart: an observe with a cold cache settles from persisted state instead.
 */
export const streamReplayCache = new InMemoryServerCache({ ttlMs: STREAM_REPLAY_TTL_MS });
