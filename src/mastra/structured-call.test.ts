import { describe, expect, it, vi } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';

import {
  streamingTextCall,
  structuredCall,
  TRANSIENT_RETRY_BASE_MS,
  type GenerateToolHooks,
  type StructuredGenerator,
  type TextStreamer,
} from './structured-call';

const shapeSchema = z.object({ name: z.string(), count: z.number().int() });

interface GenerateCall { prompt: string }

/** A fake generator that replays queued results (values or errors) and records prompts. */
function fakeGenerator(
  outcomes: ({ object?: unknown } | { throws: unknown })[],
): { agent: StructuredGenerator; calls: GenerateCall[] } {
  const calls: GenerateCall[] = [];
  const queue = [...outcomes];
  return {
    calls,
    agent: {
      async generate(prompt) {
        calls.push({ prompt });
        const next = queue.shift();
        if (!next) throw new Error('fake generator ran out of queued outcomes');
        if ('throws' in next) throw next.throws;
        return next;
      },
    },
  };
}

describe('structuredCall', () => {
  it('returns the schema-validated object on first success', async () => {
    const { agent, calls } = fakeGenerator([{ object: { name: 'a', count: 1 } }]);

    const result = await structuredCall(agent, 'extract things', shapeSchema, new RequestContext(), {
      description: 'thing extractor',
    });

    expect(result).toEqual({ name: 'a', count: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe('extract things');
  });

  it('retries a schema violation with the validation errors appended to the prompt', async () => {
    const { agent, calls } = fakeGenerator([
      { object: { name: 'a', count: 1.5 } },
      { object: { name: 'a', count: 2 } },
    ]);

    const result = await structuredCall(agent, 'extract things', shapeSchema, new RequestContext(), {
      description: 'thing extractor',
    });

    expect(result).toEqual({ name: 'a', count: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain('extract things');
    expect(calls[1]?.prompt).toContain('failed validation');
    expect(calls[1]?.prompt).toContain('count');
  });

  it('retries a missing structured object the same way', async () => {
    const { agent, calls } = fakeGenerator([{}, { object: { name: 'b', count: 3 } }]);

    const result = await structuredCall(agent, 'extract things', shapeSchema, new RequestContext(), {
      description: 'thing extractor',
    });

    expect(result).toEqual({ name: 'b', count: 3 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain('no structured output');
  });

  it('gives up after the configured attempts and names the caller', async () => {
    const { agent, calls } = fakeGenerator([{}, {}, {}]);

    await expect(
      structuredCall(agent, 'extract things', shapeSchema, new RequestContext(), {
        description: 'thing extractor',
        attempts: 2,
      }),
    ).rejects.toThrow(/thing extractor/);
    expect(calls).toHaveLength(2);
  });

  it('retries a transient provider error (429) and succeeds', async () => {
    vi.useFakeTimers();
    try {
      const rateLimited = Object.assign(new Error('rate limited'), { status: 429 });
      const { agent, calls } = fakeGenerator([
        { throws: rateLimited },
        { object: { name: 'a', count: 1 } },
      ]);

      const promise = structuredCall(agent, 'extract things', shapeSchema, new RequestContext(), {
        description: 'thing extractor',
      });
      await vi.runAllTimersAsync();

      expect(await promise).toEqual({ name: 'a', count: 1 });
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off exponentially between transient retries instead of retrying back-to-back', async () => {
    vi.useFakeTimers();
    // Pin jitter to its ceiling so each wait is exactly the attempt's full backoff cap.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      const rateLimited = Object.assign(new Error('rate limited'), { status: 429 });
      const { agent, calls } = fakeGenerator([
        { throws: rateLimited },
        { throws: rateLimited },
        { object: { name: 'a', count: 1 } },
      ]);

      const promise = structuredCall(agent, 'extract things', shapeSchema, new RequestContext(), {
        description: 'thing extractor',
      });

      // The first attempt fails; the second must not fire until the backoff elapses.
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_BASE_MS - 1);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);

      // The second failure waits twice as long before the third attempt.
      await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_BASE_MS * 2 - 1);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(3);

      expect(await promise).toEqual({ name: 'a', count: 1 });
    } finally {
      vi.mocked(Math.random).mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps validation-feedback retries immediate — no backoff on a schema violation', async () => {
    vi.useFakeTimers();
    try {
      const { agent, calls } = fakeGenerator([
        { object: { name: 'a', count: 1.5 } },
        { object: { name: 'a', count: 2 } },
      ]);

      const promise = structuredCall(agent, 'extract things', shapeSchema, new RequestContext(), {
        description: 'thing extractor',
      });
      // Flush microtasks only; no timer must be needed for the retry to run.
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(2);
      expect(await promise).toEqual({ name: 'a', count: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails fast on a non-retryable auth error without burning attempts', async () => {
    const unauthorized = Object.assign(new Error('invalid x-api-key'), { status: 401 });
    const { agent, calls } = fakeGenerator([{ throws: unauthorized }]);

    await expect(
      structuredCall(agent, 'extract things', shapeSchema, new RequestContext(), {
        description: 'thing extractor',
      }),
    ).rejects.toThrow(/invalid x-api-key/);
    expect(calls).toHaveLength(1);
  });

  it('fails fast when the error message points at configuration, without a status code', async () => {
    const badKey = new Error('Anthropic API key is missing');
    const { agent, calls } = fakeGenerator([{ throws: badKey }]);

    await expect(
      structuredCall(agent, 'extract things', shapeSchema, new RequestContext(), {
        description: 'thing extractor',
      }),
    ).rejects.toThrow(/API key/);
    expect(calls).toHaveLength(1);
  });
});

describe('structuredCall extras', () => {
  it('passes maxSteps, hooks, and abortSignal through to generate', async () => {
    const seen: Record<string, unknown>[] = [];
    const agent: StructuredGenerator = {
      async generate(_prompt, options) {
        seen.push(options);
        return { object: { name: 'a', count: 1 } };
      },
    };
    const controller = new AbortController();
    const hooks = { beforeToolCall: () => undefined };

    await structuredCall(agent, 'extract things', shapeSchema, new RequestContext(), {
      description: 'researcher',
      maxSteps: 4,
      hooks,
      abortSignal: controller.signal,
    });

    expect(seen[0]?.maxSteps).toBe(4);
    expect(seen[0]?.hooks).toBe(hooks);
    expect(seen[0]?.abortSignal).toBe(controller.signal);
  });

  it("requests errorStrategy 'warn' so an invalid object comes back for the feedback retry", async () => {
    // Mastra's default is 'strict', which throws on a schema violation before the
    // object ever reaches this module — silently bypassing the feedback-augmented
    // retry. 'warn' hands the raw object back, keeping the local safeParse the one
    // validator that drives the retry prompt.
    const seen: Parameters<StructuredGenerator['generate']>[1][] = [];
    const agent: StructuredGenerator = {
      async generate(_prompt, options) {
        seen.push(options);
        return { object: { name: 'a', count: 1 } };
      },
    };

    await structuredCall(agent, 'extract things', shapeSchema, new RequestContext(), {
      description: 'researcher',
    });

    expect(seen[0]?.structuredOutput.schema).toBe(shapeSchema);
    expect(seen[0]?.structuredOutput.errorStrategy).toBe('warn');
  });

  it('builds fresh hooks per attempt when given a factory, so per-call budgets reset on retry', async () => {
    const built: GenerateToolHooks[] = [];
    const received: (GenerateToolHooks | undefined)[] = [];
    let attempt = 0;
    const agent: StructuredGenerator = {
      async generate(_prompt, options) {
        received.push(options.hooks);
        attempt += 1;
        // First reply violates the schema, forcing a retry with new hooks.
        return { object: attempt === 1 ? { name: 'incomplete' } : { name: 'a', count: 1 } };
      },
    };
    const hooksFactory = (): GenerateToolHooks => {
      const hooks = { beforeToolCall: () => undefined };
      built.push(hooks);
      return hooks;
    };

    await structuredCall(agent, 'extract things', shapeSchema, new RequestContext(), {
      description: 'researcher',
      hooks: hooksFactory,
    });

    expect(built).toHaveLength(2);
    expect(received).toEqual(built);
    expect(received[0]).not.toBe(received[1]);
  });
});

/**
 * A fake streamer that replays queued replies (texts or errors) and records prompts.
 * Each reply streams word-sized `text-delta` chunks plus a `finish` chunk, mirroring
 * the chunk mix of a real agent stream.
 */
function fakeTextStreamer(
  outcomes: ({ text: string } | { throws: unknown })[],
): { agent: TextStreamer; calls: GenerateCall[] } {
  const calls: GenerateCall[] = [];
  const queue = [...outcomes];
  return {
    calls,
    agent: {
      async stream(prompt) {
        calls.push({ prompt });
        const next = queue.shift();
        if (!next) throw new Error('fake streamer ran out of queued outcomes');
        if ('throws' in next) throw next.throws;
        const { text } = next;
        return {
          fullStream: (async function* () {
            for (const piece of text.split(/(?<= )/)) {
              yield { type: 'text-delta', payload: { text: piece } };
            }
            yield { type: 'finish' };
          })(),
          text: Promise.resolve(text),
        };
      },
    },
  };
}

describe('streamingTextCall', () => {
  it('returns the trimmed text on first success', async () => {
    const { agent } = fakeTextStreamer([{ text: '  What did you build?  ' }]);

    const result = await streamingTextCall(agent, 'ask a question', new RequestContext(), {
      description: 'interviewer',
    });

    expect(result).toBe('What did you build?');
  });

  it('forwards only the text-delta chunks to the sink', async () => {
    const { agent } = fakeTextStreamer([{ text: 'What did you build?' }]);
    const written: unknown[] = [];

    await streamingTextCall(agent, 'ask a question', new RequestContext(), {
      description: 'interviewer',
      sink: {
        write: async (chunk) => {
          written.push(chunk);
        },
      },
    });

    expect(written).toEqual([
      { type: 'text-start', payload: {} },
      { type: 'text-delta', payload: { text: 'What ' } },
      { type: 'text-delta', payload: { text: 'did ' } },
      { type: 'text-delta', payload: { text: 'you ' } },
      { type: 'text-delta', payload: { text: 'build?' } },
    ]);
  });

  it('re-opens the sink with a text-start on each retry so a consumer can drop the failed attempt', async () => {
    const { agent } = fakeTextStreamer([{ text: '   ' }, { text: 'What did you build?' }]);
    const written: { type: string }[] = [];

    await streamingTextCall(agent, 'ask a question', new RequestContext(), {
      description: 'interviewer',
      sink: {
        write: async (chunk) => {
          written.push(chunk as { type: string });
        },
      },
    });

    // Attempt 1 (whitespace reply) and attempt 2 each open their own text-start.
    expect(written.filter((chunk) => chunk.type === 'text-start')).toHaveLength(2);
    expect(written[0]).toEqual({ type: 'text-start', payload: {} });
  });

  it('retries an empty reply with feedback and gives up after the attempts', async () => {
    const { agent, calls } = fakeTextStreamer([{ text: '' }, { text: '   ' }]);

    await expect(
      streamingTextCall(agent, 'ask a question', new RequestContext(), {
        description: 'interviewer',
        attempts: 2,
      }),
    ).rejects.toThrow(/interviewer/);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain('failed validation');
  });

  it('fails fast on a non-retryable error', async () => {
    const unauthorized = Object.assign(new Error('forbidden'), { status: 403 });
    const { agent, calls } = fakeTextStreamer([{ throws: unauthorized }]);

    await expect(
      streamingTextCall(agent, 'ask a question', new RequestContext(), { description: 'interviewer' }),
    ).rejects.toThrow(/forbidden/);
    expect(calls).toHaveLength(1);
  });
});
