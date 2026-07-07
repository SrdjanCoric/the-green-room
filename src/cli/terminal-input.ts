import { createInterface } from 'node:readline';

/**
 * Accumulate a multi-line answer: read lines until the `/done` sentinel (or end of
 * input), then join and trim them. Pure over an injected line source, so the sentinel
 * logic is testable without a real terminal.
 */
export async function collectAnswer(
  nextLine: () => Promise<string | null>,
  sentinel = '/done',
): Promise<string> {
  const lines: string[] = [];
  for (;;) {
    const line = await nextLine();
    if (line === null || line === sentinel) break;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

/** Read one multi-line answer from a stream, ending on a `/done` line or EOF. */
export async function readMultilineAnswer(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
  const rl = createInterface({ input, output });
  const iterator = rl[Symbol.asyncIterator]();
  try {
    return await collectAnswer(async () => {
      const next = await iterator.next();
      return next.done ? null : String(next.value);
    });
  } finally {
    rl.close();
  }
}
