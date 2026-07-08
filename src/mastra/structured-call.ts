import type { RequestContext } from '@mastra/core/request-context';
import type { z } from 'zod';

/**
 * The single slice of an agent's `generate` every structured call in the app uses:
 * structured output against a Zod schema, driven by the run's request context. Typing
 * the options concretely (rather than `unknown`) means a wrong `structuredOutput` shape
 * or a renamed option is caught at the call site; the real Mastra `Agent` satisfies it
 * structurally. Tests inject a fake.
 */
/** Tool-call hooks a structured call may thread through, e.g. the research fetch budget. */
export interface GenerateToolHooks {
  beforeToolCall: (context: { toolName: string }) =>
    | void
    | {
        proceed: false;
        output: { text: string; url: string };
      };
}

export interface StructuredGenerator {
  generate(
    prompt: string,
    options: {
      structuredOutput: { schema: z.ZodType };
      requestContext: RequestContext;
      maxSteps?: number;
      hooks?: GenerateToolHooks;
      abortSignal?: AbortSignal;
    },
  ): Promise<{ object?: unknown }>;
}

/** The plain-text sibling of {@link StructuredGenerator}, for agents that answer in prose. */
export interface TextGenerator {
  generate(prompt: string, options: { requestContext: RequestContext }): Promise<{ text: string }>;
}

export interface StructuredCallOptions {
  /** Names the caller in error messages, e.g. "CV parser". */
  description: string;
  /** Total attempts before giving up; defaults to 3. */
  attempts?: number;
  /** Caps the agent's tool-call loop; passed through to `generate`. */
  maxSteps?: number;
  /**
   * Tool-call hooks passed through to `generate`. Pass a factory when the hooks carry
   * per-call state (a fetch budget): it is invoked once per attempt, so a validation
   * retry starts with fresh hooks instead of an already-spent budget.
   */
  hooks?: GenerateToolHooks | (() => GenerateToolHooks);
  /** Cancels the underlying call; passed through to `generate`. */
  abortSignal?: AbortSignal;
}

const DEFAULT_ATTEMPTS = 3;

/** HTTP-ish statuses that a retry cannot fix: bad request, auth, or a missing model. */
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404]);

/** Message shapes that point at configuration rather than a transient fault. */
const NON_RETRYABLE_MESSAGE = /api key|unauthorized|forbidden|no such model|model .*not found/i;

function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    for (const key of ['status', 'statusCode'] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'number') return value;
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause && cause !== error) return errorStatus(cause);
  }
  return undefined;
}

/**
 * True when retrying the call cannot help: the failure is an auth/config problem
 * (wrong key, unknown model, malformed request), not a transient provider fault.
 * Retrying these only burns paid attempts, so the call helpers rethrow immediately.
 */
export function isNonRetryableCallError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status !== undefined) return NON_RETRYABLE_STATUSES.has(status);
  return error instanceof Error && NON_RETRYABLE_MESSAGE.test(error.message);
}

/** Render one validation failure into the feedback block appended to the retry prompt. */
function renderFeedback(prompt: string, failure: string): string {
  return (
    `${prompt}\n\n` +
    `Your previous reply failed validation:\n${failure}\n` +
    'Correct these issues and reply again in the required format.'
  );
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('\n');
}

type Attempt<T> = { ok: true; value: T } | { ok: false; feedback: string; error: unknown };

/**
 * The shared retry engine: run an attempt, retry a validation failure with the
 * feedback appended to the original prompt, retry a transient provider error as-is,
 * and rethrow a non-retryable error immediately.
 */
async function withValidationRetries<T>(params: {
  prompt: string;
  attempts: number;
  description: string;
  what: string;
  attempt: (prompt: string) => Promise<Attempt<T>>;
}): Promise<T> {
  let currentPrompt = params.prompt;
  let lastError: unknown;

  for (let attempt = 0; attempt < params.attempts; attempt += 1) {
    let outcome: Attempt<T>;
    try {
      outcome = await params.attempt(currentPrompt);
    } catch (error) {
      if (isNonRetryableCallError(error)) throw error;
      lastError = error;
      continue;
    }
    if (outcome.ok) return outcome.value;
    lastError = outcome.error;
    currentPrompt = renderFeedback(params.prompt, outcome.feedback);
  }

  throw new Error(
    `The ${params.description} produced no valid ${params.what} after ${params.attempts} attempt(s).`,
    { cause: lastError },
  );
}

/**
 * Call an agent for structured output, validate the result against the schema, and
 * retry a bounded number of times on a schema violation — appending the validation
 * errors to the retry prompt so the model can correct itself. Transient provider
 * errors retry too; auth/config errors fail fast.
 */
export async function structuredCall<Schema extends z.ZodType>(
  agent: StructuredGenerator,
  prompt: string,
  schema: Schema,
  requestContext: RequestContext,
  options: StructuredCallOptions,
): Promise<z.infer<Schema>> {
  return withValidationRetries({
    prompt,
    attempts: options.attempts ?? DEFAULT_ATTEMPTS,
    description: options.description,
    what: 'structured output',
    attempt: async (currentPrompt) => {
      const hooks = typeof options.hooks === 'function' ? options.hooks() : options.hooks;
      const result = await agent.generate(currentPrompt, {
        structuredOutput: { schema },
        requestContext,
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
        ...(hooks ? { hooks } : {}),
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
      if (result.object === undefined) {
        return {
          ok: false,
          feedback: 'the reply carried no structured output',
          error: new Error(`The ${options.description} returned no structured output.`),
        };
      }
      const parsed = schema.safeParse(result.object);
      if (!parsed.success) {
        return { ok: false, feedback: describeIssues(parsed.error), error: parsed.error };
      }
      return { ok: true, value: parsed.data };
    },
  });
}

/**
 * Call an agent for a plain-text reply with the same retry discipline as
 * {@link structuredCall}: an empty reply counts as a validation failure.
 */
export async function textCall(
  agent: TextGenerator,
  prompt: string,
  requestContext: RequestContext,
  options: StructuredCallOptions,
): Promise<string> {
  return withValidationRetries({
    prompt,
    attempts: options.attempts ?? DEFAULT_ATTEMPTS,
    description: options.description,
    what: 'reply text',
    attempt: async (currentPrompt) => {
      const result = await agent.generate(currentPrompt, { requestContext });
      const text = result.text.trim();
      if (!text) {
        return {
          ok: false,
          feedback: 'the reply was empty',
          error: new Error(`The ${options.description} returned an empty reply.`),
        };
      }
      return { ok: true, value: text };
    },
  });
}
