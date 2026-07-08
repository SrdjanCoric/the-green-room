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
      const jobs: { messageIndex: number; page: ResearchPage }[] = [];
      args.messages.forEach((message, messageIndex) => {
        for (const page of unscannedResearchPages(message, scanned)) {
          scanned.add(page.toolCallId);
          jobs.push({ messageIndex, page });
        }
      });
      if (jobs.length === 0) return undefined;

      // Pages are independent, so they scan concurrently — one detector call each,
      // not one full round trip per page in series.
      const verdicts = await Promise.all(
        jobs.map(({ page }) => scanPage(detector, page, args.abort)),
      );
      // Commit the scanned ids only after every verdict is in: an abort mid-scan
      // leaves the batch unmarked, so the next step scans it again instead of
      // waving it through.
      args.state[SCANNED_STATE_KEY] = [...scanned];

      let changed = false;
      const nextMessages = [...args.messages];
      jobs.forEach(({ messageIndex, page }, jobIndex) => {
        const verdict = verdicts[jobIndex];
        if (!verdict || verdict.clean) return;
        nextMessages[messageIndex] = withSafeResult(
          nextMessages[messageIndex]!,
          page.toolCallId,
          withheldUrl(verdict.text, page.url),
          // A flagged page's URL is withheld outright — even its origin is
          // attacker-chosen via redirect, and it buys nothing on a page the
          // detector already judged malicious.
          page.url === undefined ? undefined : '',
        );
        changed = true;
      });
      return changed ? nextMessages : undefined;
    },
  };
}

interface ResearchPage {
  toolCallId: string;
  text: string;
  /** The final URL the fetch landed on — attacker-influenceable via redirects. */
  url?: string;
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
    const url = (result as { url?: unknown }).url;
    pages.push({
      toolCallId: invocation.toolCallId,
      text: (result as { text: string }).text,
      ...(typeof url === 'string' ? { url } : {}),
    });
  }
  return pages;
}

/**
 * The scanned surface: the page text together with the final URL it came from. A
 * redirect can plant instructions in the URL's path or query, so both channels travel
 * through the detector as one text.
 */
function pageScanInput(page: ResearchPage): string {
  return page.url === undefined ? page.text : `Fetched from: ${page.url}\n\n${page.text}`;
}

/**
 * Scrub the flagged page's URL out of the detector's rewrite before it is seated: the
 * rewrite covers the whole scan surface, so the "Fetched from:" line (full URL, riders
 * and all) can survive it verbatim — withholding the `url` field alone is not enough.
 */
function withheldUrl(verdictText: string, url: string | undefined): string {
  if (url === undefined) return verdictText;
  return verdictText.split(url).join('[url withheld]');
}

/**
 * Run one page through the detector. The scan surface travels inside a synthetic text
 * message because the built-in detector reads and rewrites text parts only; a verdict
 * that differs from the input is carried back and re-seated in the tool result by the
 * caller (a clean page keeps its original text and URL untouched).
 *
 * Inherited trade-off: the built-in detector fails open on an internal detection
 * fault (it returns the message unchanged), which the equality check below cannot
 * distinguish from a genuinely clean page. Detection fidelity is deliberately
 * delegated to Mastra rather than re-implemented here.
 */
async function scanPage(
  detector: PageInjectionScanner,
  page: ResearchPage,
  abort: (reason?: string) => never,
): Promise<{ clean: boolean; text: string }> {
  const scanInput = pageScanInput(page);
  const synthetic: MastraDBMessage = {
    id: `${RESEARCH_PAGE_GUARD_ID}:${page.toolCallId}`,
    role: 'user',
    createdAt: new Date(),
    content: { format: 2, parts: [{ type: 'text', text: scanInput }] },
  };

  const verdict = await detector.processInput({ messages: [synthetic], abort });
  const returned = verdict[0];
  // In rewrite mode the detector filters only when it has no rewrite to offer.
  if (!returned) return { clean: false, text: WITHHELD_PAGE_TEXT };
  const text = extractText(returned);
  if (text === undefined) return { clean: false, text: WITHHELD_PAGE_TEXT };
  return text === scanInput ? { clean: true, text: page.text } : { clean: false, text };
}

function extractText(message: MastraDBMessage): string | undefined {
  for (const part of message.content.parts) {
    if (part.type === 'text' && typeof part.text === 'string') return part.text;
  }
  return typeof message.content.content === 'string' ? message.content.content : undefined;
}

/** Copy a message with one tool result's text (and, when given, URL) replaced, everything else intact. */
function withSafeResult(
  message: MastraDBMessage,
  toolCallId: string,
  text: string,
  url: string | undefined,
): MastraDBMessage {
  const replacement = { text, ...(url !== undefined ? { url } : {}) };
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
          result && typeof result === 'object' ? { ...result, ...replacement } : replacement;
        return { ...part, toolInvocation: { ...part.toolInvocation, result: nextResult } };
      }),
    },
  };
}
