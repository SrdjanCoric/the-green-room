import type { MastraDBMessage, MastraMessagePart } from '@mastra/core/agent/message-list';
import {
  PromptInjectionDetector,
  type InputProcessor,
  type ProcessInputStepArgs,
} from '@mastra/core/processors';

import { RESEARCH_FETCH_TOOL_KEY } from '../tools/fetch-research-page';

export const RESEARCH_PAGE_GUARD_ID = 'research-page-guard';

/**
 * Replacement text for a page the detector flagged but could not rewrite. The message
 * itself must survive — dropping it would orphan the tool call — so only its content is
 * withheld and research continues minus one source.
 */
export const WITHHELD_PAGE_TEXT =
  '[Page content withheld: it appeared to contain prompt-injection instructions.]';

/** The one slice of the built-in detector this guard delegates to; the test seam. */
export type PageInjectionScanner = Pick<PromptInjectionDetector, 'processInput'>;

const SCANNED_STATE_KEY = 'scannedToolCallIds';

export interface ResearchPageGuardOptions {
  /** Model for the built-in detection agent (the fast tier). */
  model: string;
  /** Detection delegate; defaults to a built-in `PromptInjectionDetector` in rewrite mode. */
  detector?: PageInjectionScanner;
}

/**
 * Step-phase guard for the genuinely untrusted research channel: fetched pages, which
 * enter the loop as tool results and are invisible to the `processInput` detector that
 * guards the posting-derived prompt. Each step it picks out the not-yet-scanned results
 * of the research fetch tool and delegates them to a built-in `PromptInjectionDetector`
 * with `strategy: 'rewrite'` — all detection and neutralization logic is Mastra's; this
 * processor is only the phase adapter. A rewrite lands back inside the tool result, so
 * the tool-call/tool-result pairing survives and research continues minus one source.
 */
export function createResearchPageGuard(options: ResearchPageGuardOptions): InputProcessor {
  const detector =
    options.detector ??
    new PromptInjectionDetector({
      model: options.model,
      threshold: 0.8,
      strategy: 'rewrite',
      detectionTypes: ['injection', 'jailbreak', 'system-override'],
    });

  return {
    id: RESEARCH_PAGE_GUARD_ID,
    name: 'Research Page Guard',
    async processInputStep(args: ProcessInputStepArgs): Promise<MastraDBMessage[] | undefined> {
      const scanned = readScannedIds(args.state);
      let changed = false;

      const nextMessages: MastraDBMessage[] = [];
      for (const message of args.messages) {
        const pages = unscannedResearchPages(message, scanned);
        if (pages.length === 0) {
          nextMessages.push(message);
          continue;
        }

        let current = message;
        for (const page of pages) {
          scanned.add(page.toolCallId);
          const safeText = await scanPageText(detector, page, args.abort);
          if (safeText === page.text) continue;
          current = withResultText(current, page.toolCallId, safeText);
          changed = true;
        }
        nextMessages.push(current);
      }

      args.state[SCANNED_STATE_KEY] = [...scanned];
      return changed ? nextMessages : undefined;
    },
  };
}

interface ResearchPage {
  toolCallId: string;
  text: string;
}

function readScannedIds(state: Record<string, unknown>): Set<string> {
  const raw = state[SCANNED_STATE_KEY];
  return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []);
}

/** Completed research-fetch results in this message that have not been scanned yet. */
function unscannedResearchPages(message: MastraDBMessage, scanned: Set<string>): ResearchPage[] {
  const pages: ResearchPage[] = [];
  for (const part of message.content.parts) {
    if (part.type !== 'tool-invocation') continue;
    const invocation = part.toolInvocation;
    if (invocation.toolName !== RESEARCH_FETCH_TOOL_KEY) continue;
    if (invocation.state !== 'result') continue;
    if (scanned.has(invocation.toolCallId)) continue;
    const result = invocation.result;
    if (!result || typeof result !== 'object' || typeof (result as { text?: unknown }).text !== 'string') {
      continue;
    }
    pages.push({ toolCallId: invocation.toolCallId, text: (result as { text: string }).text });
  }
  return pages;
}

/**
 * Run one page through the detector. The page text travels inside a synthetic text
 * message because the built-in detector reads and rewrites text parts only; the verdict
 * is carried back as plain text and re-seated in the tool result by the caller.
 */
async function scanPageText(
  detector: PageInjectionScanner,
  page: ResearchPage,
  abort: (reason?: string) => never,
): Promise<string> {
  const synthetic: MastraDBMessage = {
    id: `${RESEARCH_PAGE_GUARD_ID}:${page.toolCallId}`,
    role: 'user',
    createdAt: new Date(),
    content: { format: 2, parts: [{ type: 'text', text: page.text }] },
  };

  const verdict = await detector.processInput({ messages: [synthetic], abort });
  const returned = verdict[0];
  // In rewrite mode the detector filters only when it has no rewrite to offer.
  if (!returned) return WITHHELD_PAGE_TEXT;
  return extractText(returned) ?? WITHHELD_PAGE_TEXT;
}

function extractText(message: MastraDBMessage): string | undefined {
  for (const part of message.content.parts) {
    if (part.type === 'text' && typeof part.text === 'string') return part.text;
  }
  return typeof message.content.content === 'string' ? message.content.content : undefined;
}

/** Copy a message with one tool result's text replaced, everything else intact. */
function withResultText(
  message: MastraDBMessage,
  toolCallId: string,
  text: string,
): MastraDBMessage {
  return {
    ...message,
    content: {
      ...message.content,
      parts: message.content.parts.map((part: MastraMessagePart) => {
        if (part.type !== 'tool-invocation' || part.toolInvocation.toolCallId !== toolCallId) {
          return part;
        }
        const result = part.toolInvocation.result;
        const nextResult =
          result && typeof result === 'object' ? { ...result, text } : { text };
        return { ...part, toolInvocation: { ...part.toolInvocation, result: nextResult } };
      }),
    },
  };
}
