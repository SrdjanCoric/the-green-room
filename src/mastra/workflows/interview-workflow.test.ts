import { describe, expect, it } from 'vitest';

import { RequestContext } from '@mastra/core/request-context';

import { candidateMemory } from '../memory';
import { candidateProfileSchema } from '../schemas/candidate-profile';
import { createAgentExtractor, persistCandidateProfile } from './interview-workflow';

const cannedProfile = {
  name: 'Ada Lovelace',
  headline: 'Staff Engineer',
  technologies: ['Rust'],
};

describe('persistCandidateProfile', () => {
  it('validates the extracted profile and writes it to working memory keyed by resourceId', async () => {
    const resourceId = 'candidate-ada';
    const threadId = 'session-1';

    const profile = await persistCandidateProfile({
      extractor: async () => cannedProfile,
      cvText: 'irrelevant here — the model boundary is mocked',
      memory: candidateMemory,
      resourceId,
      threadId,
    });

    // Defaults are applied, so the persisted profile is always schema-complete.
    expect(profile.name).toBe('Ada Lovelace');
    expect(profile.technologies).toEqual(['Rust']);
    expect(profile.roles).toEqual([]);

    const stored = await candidateMemory.getWorkingMemory({ resourceId, threadId });
    expect(stored).not.toBeNull();
    const reloaded = candidateProfileSchema.parse(JSON.parse(stored as string));
    expect(reloaded).toMatchObject({ name: 'Ada Lovelace', technologies: ['Rust'] });
  });

  it('keeps profiles isolated per resourceId', async () => {
    await persistCandidateProfile({
      extractor: async () => ({ name: 'Grace Hopper' }),
      cvText: 'x',
      memory: candidateMemory,
      resourceId: 'candidate-grace',
      threadId: 'session-2',
    });

    const own = await candidateMemory.getWorkingMemory({
      resourceId: 'candidate-grace',
      threadId: 'session-2',
    });
    expect(JSON.parse(own as string).name).toBe('Grace Hopper');

    // A different, never-written candidate must not see Grace's profile.
    const unrelated = await candidateMemory.getWorkingMemory({
      resourceId: 'candidate-never-written',
      threadId: 'session-2',
    });
    expect(unrelated).toBeNull();
  });

  it('exposes the profile to any thread of the same resource (scope: resource)', async () => {
    await persistCandidateProfile({
      extractor: async () => ({ name: 'Alan Turing' }),
      cvText: 'x',
      memory: candidateMemory,
      resourceId: 'candidate-alan',
      threadId: 'session-first',
    });

    // A different thread under the same resource must observe the same profile.
    const fromAnotherThread = await candidateMemory.getWorkingMemory({
      resourceId: 'candidate-alan',
      threadId: 'session-second',
    });
    expect(JSON.parse(fromAnotherThread as string).name).toBe('Alan Turing');
  });

  it('rejects a malformed extraction that violates the profile schema', async () => {
    await expect(
      persistCandidateProfile({
        extractor: async () => ({ roles: [{ company: 'NoTitle Inc' }] }),
        cvText: 'x',
        memory: candidateMemory,
        resourceId: 'candidate-bad',
        threadId: 'session-bad',
      }),
    ).rejects.toThrow();
  });

  it('rejects an empty extraction rather than persisting a blank profile', async () => {
    await expect(
      persistCandidateProfile({
        extractor: async () => ({}),
        cvText: 'x',
        memory: candidateMemory,
        resourceId: 'candidate-empty',
        threadId: 'session-empty',
      }),
    ).rejects.toThrow(/no.*profile/i);
  });

  it('treats a profile of only blank strings as empty', async () => {
    await expect(
      persistCandidateProfile({
        extractor: async () => ({ name: '   ', headline: '' }),
        cvText: 'x',
        memory: candidateMemory,
        resourceId: 'candidate-blank',
        threadId: 'session-blank',
      }),
    ).rejects.toThrow(/no.*profile/i);
  });
});

describe('createAgentExtractor', () => {
  const requestContext = new RequestContext();

  it('requests structured output against the profile schema, forwarding the tiering context', async () => {
    let seenSchema: unknown;
    let seenContext: unknown;
    const extractor = createAgentExtractor(
      {
        generate: async (_prompt, options) => {
          seenSchema = options.structuredOutput.schema;
          seenContext = options.requestContext;
          return { object: candidateProfileSchema.parse({ name: 'Ada Lovelace' }) };
        },
      },
      requestContext,
    );

    const raw = await extractor('cv text');
    expect(seenSchema).toBe(candidateProfileSchema);
    // Model tiering depends on the run's request context reaching the agent.
    expect(seenContext).toBe(requestContext);
    expect(raw).toMatchObject({ name: 'Ada Lovelace' });
  });

  it('throws when the model returns no structured object', async () => {
    const extractor = createAgentExtractor(
      { generate: async () => ({ object: undefined }) },
      requestContext,
    );

    await expect(extractor('cv text')).rejects.toThrow(/no structured profile/i);
  });
});
