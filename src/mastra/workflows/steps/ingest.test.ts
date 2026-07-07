import { describe, expect, it, vi } from 'vitest';

import { RequestContext } from '@mastra/core/request-context';

import { candidateMemory } from '../../memory';
import { candidateProfileSchema } from '../../schemas/candidate-profile';
import { DEFAULT_ROLE_CONTEXT, roleContextSchema } from '../../schemas/role-context';
import {
  buildRoleContext,
  createAgentExtractor,
  createRoleContextBuilder,
  persistCandidateProfile,
  resolveCandidateIdentity,
} from './ingest';

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

    // Working memory now holds the full ledger shape: the profile plus the
    // (initially empty) session ledger.
    const stored = await candidateMemory.getWorkingMemory({ resourceId, threadId });
    expect(stored).not.toBeNull();
    const reloaded = JSON.parse(stored as string);
    expect(candidateProfileSchema.parse(reloaded.profile)).toMatchObject({
      name: 'Ada Lovelace',
      technologies: ['Rust'],
    });
    expect(reloaded.sessions).toEqual([]);
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
    expect(JSON.parse(own as string).profile.name).toBe('Grace Hopper');

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
    expect(JSON.parse(fromAnotherThread as string).profile.name).toBe('Alan Turing');
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

describe('persistCandidateProfile ledger preservation', () => {
  it('keeps the existing session ledger when a new session re-ingests the profile', async () => {
    const resourceId = 'candidate-returning';
    const session = {
      runId: 'run-old',
      date: '2026-07-01T00:00:00.000Z',
      role: 'Engineer',
      questionCount: 2,
      averageScore: 3,
      topGaps: ['gap'],
      drillFoci: ['focus'],
    };

    await persistCandidateProfile({
      extractor: async () => ({ name: 'First Pass' }),
      cvText: 'x',
      memory: candidateMemory,
      resourceId,
      threadId: 'session-a',
    });
    // Simulate a coached session having written a ledger entry.
    await candidateMemory.updateWorkingMemory({
      resourceId,
      threadId: 'session-a',
      workingMemory: JSON.stringify({
        profile: candidateProfileSchema.parse({ name: 'First Pass' }),
        sessions: [session],
      }),
    });

    // A later interview re-ingests the (possibly updated) CV: the profile refreshes,
    // the ledger survives.
    await persistCandidateProfile({
      extractor: async () => ({ name: 'Second Pass' }),
      cvText: 'x',
      memory: candidateMemory,
      resourceId,
      threadId: 'session-b',
    });

    const stored = await candidateMemory.getWorkingMemory({
      resourceId,
      threadId: 'session-b',
    });
    const reloaded = JSON.parse(stored as string);
    expect(reloaded.profile.name).toBe('Second Pass');
    expect(reloaded.sessions).toEqual([session]);
  });
});

describe('resolveCandidateIdentity', () => {
  it('prefers the explicit override over everything', () => {
    expect(
      resolveCandidateIdentity({ override: '  jane-custom ', cvText: 'contact: jane@example.com' }),
    ).toEqual({ candidateId: 'jane-custom', candidateIdOrigin: 'flag' });
  });

  it('falls back to the first email in the CV, trimmed and lowercased', () => {
    expect(
      resolveCandidateIdentity({
        cvText: 'Jane Doe\nContact: Jane.Doe+CV@Example.COM or jd@other.org',
      }),
    ).toEqual({ candidateId: 'jane.doe+cv@example.com', candidateIdOrigin: 'cv' });
  });

  it("falls back to 'default' when there is no override and no email", () => {
    expect(resolveCandidateIdentity({ cvText: 'no contact details here' })).toEqual({
      candidateId: 'default',
      candidateIdOrigin: 'default',
    });
  });

  it('treats a blank override as absent', () => {
    expect(resolveCandidateIdentity({ override: '   ', cvText: 'a@b.co' })).toEqual({
      candidateId: 'a@b.co',
      candidateIdOrigin: 'cv',
    });
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

  it('retries a missing structured object before giving up', async () => {
    let calls = 0;
    const extractor = createAgentExtractor(
      {
        generate: async () => {
          calls += 1;
          return { object: undefined };
        },
      },
      requestContext,
    );

    await expect(extractor('cv text')).rejects.toThrow(/CV parser/i);
    expect(calls).toBe(3);
  });
});

describe('createRoleContextBuilder', () => {
  const requestContext = new RequestContext();
  const cannedRole = roleContextSchema.parse({
    company: 'Globex',
    role: 'Staff Engineer',
    competencies: [{ name: 'Distributed systems', weight: 5 }],
  });

  it('requests structured output against the role-context schema, forwarding the tiering context', async () => {
    let seenSchema: unknown;
    let seenContext: unknown;
    let seenPrompt = '';
    const builder = createRoleContextBuilder(
      {
        generate: async (prompt, options) => {
          seenPrompt = prompt;
          seenSchema = options.structuredOutput.schema;
          seenContext = options.requestContext;
          return { object: cannedRole };
        },
      },
      requestContext,
    );

    const role = await builder('Staff Engineer at Globex. Owns distributed systems.');

    expect(seenSchema).toBe(roleContextSchema);
    expect(seenContext).toBe(requestContext);
    expect(seenPrompt).toContain('Owns distributed systems.');
    expect(role.company).toBe('Globex');
  });

  it('retries a missing structured role context before giving up', async () => {
    const builder = createRoleContextBuilder(
      { generate: async () => ({ object: undefined }) },
      requestContext,
    );

    await expect(builder('some posting')).rejects.toThrow(/role builder/i);
  });
});

describe('buildRoleContext', () => {
  it('derives the role context from posting text via the builder', async () => {
    const role = await buildRoleContext({
      builder: async (postingText) =>
        roleContextSchema.parse({ role: 'Derived', summary: postingText }),
      postingText: 'A posting',
    });

    expect(role.role).toBe('Derived');
    expect(role.summary).toBe('A posting');
  });

  it('falls back to the default role context when no posting is provided', async () => {
    const builder = vi.fn();
    const role = await buildRoleContext({ builder, postingText: undefined });

    expect(role).toBe(DEFAULT_ROLE_CONTEXT);
    expect(builder).not.toHaveBeenCalled();
  });

  it('falls back to the default when the posting text is blank', async () => {
    const builder = vi.fn();
    const role = await buildRoleContext({ builder, postingText: '   ' });

    expect(role).toBe(DEFAULT_ROLE_CONTEXT);
    expect(builder).not.toHaveBeenCalled();
  });
});
