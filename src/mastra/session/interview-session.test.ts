import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  describeDriveFailure,
  driveInterview,
  loadLastRun,
  saveLastRun,
  type DriveResult,
} from './interview-session';

describe('last-run persistence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'interview-session-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips the latest run pointer through a file', async () => {
    const path = join(dir, 'nested', 'last-run.json');
    await saveLastRun({ runId: 'run-123', threadId: 'sess-1' }, path);

    const loaded = await loadLastRun(path);
    expect(loaded).toEqual({ runId: 'run-123', threadId: 'sess-1' });

    // The file is real JSON on disk, not an in-memory shim.
    const raw = JSON.parse(await readFile(path, 'utf8')) as { runId: string };
    expect(raw.runId).toBe('run-123');
  });

  it('returns null when no pointer has been saved', async () => {
    expect(await loadLastRun(join(dir, 'missing.json'))).toBeNull();
  });
});

describe('driveInterview', () => {
  it('answers the level prompt then every question until the run succeeds', async () => {
    // A scripted suspend/resume sequence standing in for the workflow run.
    const script: DriveResult[] = [
      { status: 'suspended', suspendPayload: { collectLevel: { kind: 'level', prompt: 'Level?' } } },
      {
        status: 'suspended',
        suspendPayload: {
          interviewTurn: { kind: 'question', question: 'Q1', questionNumber: 1, action: 'new_topic' },
        },
      },
      {
        status: 'suspended',
        suspendPayload: {
          interviewTurn: { kind: 'question', question: 'Q2', questionNumber: 2, action: 'follow_up' },
        },
      },
      { status: 'success', result: { transcript: [] } },
    ];
    let cursor = 0;
    const resume = vi.fn(async () => script[++cursor]!);

    const onLevel = vi.fn(async () => 'senior');
    const seenQuestions: string[] = [];
    const onQuestion = vi.fn(async (question: string) => {
      seenQuestions.push(question);
      return `answer to ${question}`;
    });

    const final = await driveInterview({ initial: script[0]!, resume, onLevel, onQuestion });

    expect(final.status).toBe('success');
    expect(onLevel).toHaveBeenCalledWith('Level?');
    expect(seenQuestions).toEqual(['Q1', 'Q2']);
    expect(resume).toHaveBeenNthCalledWith(1, { level: 'senior' });
    expect(resume).toHaveBeenNthCalledWith(2, { answer: 'answer to Q1' });
    expect(resume).toHaveBeenNthCalledWith(3, { answer: 'answer to Q2' });
  });

  it('returns immediately when the run is not suspended', async () => {
    const resume = vi.fn();
    const final = await driveInterview({
      initial: { status: 'success', result: { transcript: [] } },
      resume,
      onLevel: async () => 'x',
      onQuestion: async () => 'x',
    });

    expect(final.status).toBe('success');
    expect(resume).not.toHaveBeenCalled();
  });

  it('throws when a suspension carries no recognizable interview prompt', async () => {
    await expect(
      driveInterview({
        initial: { status: 'suspended', suspendPayload: { mystery: { kind: 'other' } } },
        resume: async () => ({ status: 'success' }),
        onLevel: async () => 'x',
        onQuestion: async () => 'x',
      }),
    ).rejects.toThrow(/prompt/i);
  });
});

describe('describeDriveFailure', () => {
  it('surfaces the serialized cause of a failed run and is null on success', () => {
    expect(describeDriveFailure({ status: 'success', result: {} })).toBeNull();
    expect(
      describeDriveFailure({ status: 'failed', error: { message: 'unsupported file type' } }),
    ).toMatch(/unsupported/i);
    expect(describeDriveFailure({ status: 'canceled' })).toMatch(/canceled/i);
  });
});
