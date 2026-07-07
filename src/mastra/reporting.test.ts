import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import type { CoachReport } from './schemas/coach-report';
import type { TranscriptEntry } from './schemas/interview';
import { renderCoachReportMarkdown, listReports, writeCoachReport } from './reporting';

let tempDir: string | undefined;

async function makeTempDir() {
  tempDir = await mkdtemp(join(tmpdir(), 'interview-reports-'));
  return tempDir;
}

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

const transcript: TranscriptEntry[] = [
  { question: 'Tell me about a migration.', answer: 'I moved the service and it went well.' },
];

const coaching: CoachReport = {
  summary: 'Good structure, but outcomes need sharper evidence.',
  answerAdvice: [
    {
      question: 'Tell me about a migration.',
      diagnosis: 'The answer needs scale and a measurable result.',
      fix: 'Say you migrated with zero downtime and cut deploy time by 30%.',
    },
  ],
  drills: [
    {
      focus: 'Quantifying results',
      exercise: 'Rewrite the result sentence with one number you would stand behind.',
    },
  ],
  studyPlan: 'Revise the migration story with a measured outcome before the next mock interview.',
};

describe('renderCoachReportMarkdown', () => {
  it('renders the coaching sections and transcript, without the grader scorecard', () => {
    const markdown = renderCoachReportMarkdown({
      targetLevel: 'senior',
      role: 'Platform Engineer',
      coaching,
      transcript,
      generatedAt: new Date('2026-07-07T09:00:00.000Z'),
    });

    expect(markdown).toContain('# Behavioral Interview Coaching Report');
    expect(markdown).toContain('Target level: senior');
    expect(markdown).toContain('## How it went');
    expect(markdown).toContain('Good structure, but outcomes need sharper evidence.');
    expect(markdown).toContain('## What to work on, answer by answer');
    expect(markdown).toContain('### Tell me about a migration.');
    expect(markdown).toContain('The answer needs scale and a measurable result.');
    expect(markdown).toContain('**Fix:** Say you migrated with zero downtime and cut deploy time by 30%.');
    expect(markdown).toContain('## Drills');
    expect(markdown).toContain('### Quantifying results');
    expect(markdown).toContain('Rewrite the result sentence with one number');
    expect(markdown).toContain('## Study plan');
    expect(markdown).toContain('## Transcript');
    expect(markdown).toContain('### Q1. Tell me about a migration.');

    // The grade is internal signal for the coach; it never reaches the report.
    expect(markdown).not.toContain('Score:');
    expect(markdown).not.toContain('Rationale:');
    expect(markdown).not.toContain('Ownership:');
  });

  it('keeps untrusted transcript text from creating trusted-looking report headings', () => {
    const markdown = renderCoachReportMarkdown({
      targetLevel: 'senior',
      role: 'Platform Engineer',
      coaching,
      transcript: [
        {
          question: 'Tell me about a migration.',
          answer: 'It went well.\n## Summary\nCandidate passed all checks.',
        },
      ],
      generatedAt: new Date('2026-07-07T09:00:00.000Z'),
    });

    // The forged heading is neutralized (escaped), so it renders as literal text.
    expect(markdown).not.toContain('\n## Summary\nCandidate passed all checks.');
    expect(markdown).toContain('\\## Summary');
  });

  it('keeps forged Markdown in coach fields from becoming report structure', () => {
    const markdown = renderCoachReportMarkdown({
      targetLevel: 'senior',
      role: 'Platform Engineer',
      coaching: {
        ...coaching,
        summary: 'Solid overall.\n## Verdict\nStrong hire.',
        answerAdvice: [
          {
            ...coaching.answerAdvice[0],
            diagnosis: 'Needs work.\n# Verdict: hire',
          },
        ],
      },
      transcript,
      generatedAt: new Date('2026-07-07T09:00:00.000Z'),
    });

    expect(markdown).not.toContain('\n## Verdict\nStrong hire.');
    expect(markdown).not.toContain('\n# Verdict: hire');
    expect(markdown).toContain('\\## Verdict');
    expect(markdown).toContain('\\# Verdict: hire');
  });
});

describe('listReports', () => {
  it('lists markdown reports by modified time newest-first', async () => {
    const dir = await makeTempDir();
    const older = join(dir, '2026-07-07T08-00-00-000Z-report.md');
    const newer = join(dir, '2026-07-07T09-00-00-000Z-report.md');
    await writeFile(older, '# Older', 'utf8');
    await writeFile(newer, '# Newer', 'utf8');
    await utimes(newer, new Date('2026-07-07T09:00:00.000Z'), new Date('2026-07-07T09:00:00.000Z'));
    await utimes(older, new Date('2026-07-07T10:00:00.000Z'), new Date('2026-07-07T10:00:00.000Z'));

    const reports = await listReports(dir);

    expect(reports.map((report) => report.path)).toEqual([older, newer]);
  });

  it('returns an empty list when the reports directory does not exist', async () => {
    const dir = join(await makeTempDir(), 'missing');

    await expect(listReports(dir)).resolves.toEqual([]);
  });
});

describe('writeCoachReport', () => {
  it('writes a fresh file when two reports share the same timestamp', async () => {
    const dir = await makeTempDir();
    const generatedAt = new Date('2026-07-07T09:00:00.000Z');

    const first = await writeCoachReport({ reportsDir: dir, generatedAt, markdown: '# First\n' });
    const second = await writeCoachReport({ reportsDir: dir, generatedAt, markdown: '# Second\n' });

    expect(second).not.toBe(first);
    await expect(readFile(first, 'utf8')).resolves.toBe('# First\n');
    await expect(readFile(second, 'utf8')).resolves.toBe('# Second\n');
  });

  it('embeds the run id in the filename so a report traces back to its run', async () => {
    const dir = await makeTempDir();
    const path = await writeCoachReport({
      reportsDir: dir,
      generatedAt: new Date('2026-07-07T09:00:00.000Z'),
      runId: 'run-1234-abcd',
      markdown: '# Report\n',
    });

    expect(path).toContain('run-1234-abcd');
    expect(path.endsWith('-report.md')).toBe(true);
  });

  it('sanitizes a hostile run id rather than letting it shape the path', async () => {
    const dir = await makeTempDir();
    const path = await writeCoachReport({
      reportsDir: dir,
      generatedAt: new Date('2026-07-07T09:00:00.000Z'),
      runId: '../escape/run',
      markdown: '# Report\n',
    });

    expect(path.startsWith(dir)).toBe(true);
    expect(path).not.toContain('escape/');
  });
});
