import { describe, expect, it } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';

import { structuredCall, textCall, type StructuredGenerator, type TextGenerator } from './structured-call';

const shapeSchema = z.object({ name: z.string(), count: z.number().int() });

type GenerateCall = { prompt: string };

/** A fake generator that replays queued results (values or errors) and records prompts. */
function fakeGenerator(
  outcomes: Array<{ object?: unknown } | { throws: unknown }>,
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
    const rateLimited = Object.assign(new Error('rate limited'), { status: 429 });
    const { agent, calls } = fakeGenerator([
      { throws: rateLimited },
      { object: { name: 'a', count: 1 } },
    ]);

    const result = await structuredCall(agent, 'extract things', shapeSchema, new RequestContext(), {
      description: 'thing extractor',
    });

    expect(result).toEqual({ name: 'a', count: 1 });
    expect(calls).toHaveLength(2);
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
    const seen: Array<Record<string, unknown>> = [];
    const agent: StructuredGenerator = {
      async generate(_prompt, options) {
        seen.push(options as unknown as Record<string, unknown>);
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
});

function fakeTextGenerator(
  outcomes: Array<{ text: string } | { throws: unknown }>,
): { agent: TextGenerator; calls: GenerateCall[] } {
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

describe('textCall', () => {
  it('returns the trimmed text on first success', async () => {
    const { agent } = fakeTextGenerator([{ text: '  What did you build?  ' }]);

    const result = await textCall(agent, 'ask a question', new RequestContext(), {
      description: 'interviewer',
    });

    expect(result).toBe('What did you build?');
  });

  it('retries an empty reply with feedback and gives up after the attempts', async () => {
    const { agent, calls } = fakeTextGenerator([{ text: '' }, { text: '   ' }]);

    await expect(
      textCall(agent, 'ask a question', new RequestContext(), {
        description: 'interviewer',
        attempts: 2,
      }),
    ).rejects.toThrow(/interviewer/);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain('failed validation');
  });

  it('fails fast on a non-retryable error', async () => {
    const unauthorized = Object.assign(new Error('forbidden'), { status: 403 });
    const { agent, calls } = fakeTextGenerator([{ throws: unauthorized }]);

    await expect(
      textCall(agent, 'ask a question', new RequestContext(), { description: 'interviewer' }),
    ).rejects.toThrow(/forbidden/);
    expect(calls).toHaveLength(1);
  });
});
