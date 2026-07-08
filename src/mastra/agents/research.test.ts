import { describe, expect, it } from 'vitest';

import { buildModelRequestContext, resolveModelTiers } from '../model-config';
import { RESEARCH_PAGE_GUARD_ID } from '../processors/research-page-guard';
import { RESEARCH_FETCH_TOOL_KEY, fetchResearchPageTool } from '../tools/fetch-research-page';
import { researchAgent } from './research';

describe('research agent wiring', () => {
  const requestContext = buildModelRequestContext(resolveModelTiers({}));

  it('exposes the allow-listed fetch tool under its registration key', async () => {
    const tools = await researchAgent.listTools();

    expect(tools[RESEARCH_FETCH_TOOL_KEY]?.id).toBe(fetchResearchPageTool.id);
  });

  it('keeps both injection guards attached: the posting detector and the page guard', async () => {
    // The page guard is the only defense on the fetched-page channel (the regex
    // tripwire it replaced is gone), so losing this registration would silently
    // strip the control while every other test stays green.
    const processors = await researchAgent.listConfiguredInputProcessors(requestContext);
    const ids = processors.map((processor) => processor.id);

    expect(ids).toContain('prompt-injection-detector');
    expect(ids).toContain(RESEARCH_PAGE_GUARD_ID);
  });
});
