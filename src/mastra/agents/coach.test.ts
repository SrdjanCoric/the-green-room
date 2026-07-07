import { describe, expect, it } from 'vitest';

import { COACH_RETRIEVAL_TOOL_KEY, coachRetrievalTool } from '../tools/coach-retrieval';
import { COACH_SYSTEM_PROMPT, coachAgent } from './coach';

describe('coach agent RAG grounding', () => {
  it('exposes the how-to-answer retrieval tool so per-answer fixes are grounded in the corpus', async () => {
    const tools = await coachAgent.listTools();

    // Assert the exposed tool is the actual retrieval tool, not merely that some tool
    // is registered under the key — a misconfigured tool would then fail here.
    expect(tools[COACH_RETRIEVAL_TOOL_KEY]?.id).toBe(coachRetrievalTool.id);
  });

  it('names the retrieval tool in its instructions so the prompt and the attached tool cannot drift', () => {
    expect(COACH_SYSTEM_PROMPT).toContain(COACH_RETRIEVAL_TOOL_KEY);
  });
});
