import { mkdir, open, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { dataDir } from './data-dir';
import type { CoachReport } from './schemas/coach-report';
import type { TranscriptEntry } from './schemas/interview';

export interface RenderReportInput {
  targetLevel: string;
  role: string;
  coaching: CoachReport;
  transcript: TranscriptEntry[];
  generatedAt: Date;
}

export interface ReportListing {
  path: string;
  name: string;
  modifiedAt: Date;
}

/** Reports live beside the database under the project-root `data/` directory, so the
 *  CLI and `mastra dev` write and list the same reports from any working directory. */
export function defaultReportsDir(): string {
  return join(dataDir, 'reports');
}

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

// The coach speaks about an untrusted transcript, so its free-text is untrusted too: a
// prompt-injected answer can push the model to emit Markdown that forges trusted-looking
// report structure (headings, block quotes, lists). Collapse a value that renders on a
// heading line onto a single line, so no embedded newline can open a new block.
function inlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// Neutralize a multi-line prose block by escaping a leading Markdown structural token on
// each line, so injected text can never forge a heading, block quote, or list while the
// prose still reads normally.
function neutralizeMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^(\s*)([#>]|[-*+](?=\s)|\d+\.(?=\s))/, '$1\\$2'))
    .join('\n');
}

export function renderCoachReportMarkdown(input: RenderReportInput): string {
  const coaching = input.coaching;
  const lines: string[] = [
    '# Behavioral Interview Coaching Report',
    '',
    `Generated: ${input.generatedAt.toISOString()}`,
    `Target level: ${inlineText(input.targetLevel)}`,
    `Role: ${inlineText(input.role)}`,
  ];

  const summary = coaching.summary.trim();
  if (summary) {
    lines.push('', '## How it went', '', neutralizeMarkdown(summary));
  }

  if (coaching.answerAdvice.length > 0) {
    lines.push('', '## What to work on, answer by answer');
    for (const advice of coaching.answerAdvice) {
      lines.push(
        '',
        `### ${inlineText(advice.question)}`,
        '',
        neutralizeMarkdown(advice.diagnosis),
        '',
        `**Fix:** ${neutralizeMarkdown(advice.fix)}`,
      );
    }
  }

  if (coaching.drills.length > 0) {
    lines.push('', '## Drills');
    for (const drill of coaching.drills) {
      lines.push('', `### ${inlineText(drill.focus)}`, '', neutralizeMarkdown(drill.exercise));
    }
  }

  const studyPlan = coaching.studyPlan.trim();
  if (studyPlan) {
    lines.push('', '## Study plan', '', neutralizeMarkdown(studyPlan));
  }

  lines.push('', '## Transcript');
  if (input.transcript.length === 0) {
    lines.push('', 'No questions were asked.');
  } else {
    input.transcript.forEach((turn, index) => {
      lines.push(
        '',
        `### Q${index + 1}. ${inlineText(turn.question)}`,
        '',
        neutralizeMarkdown(turn.answer),
      );
    });
  }

  return `${lines.join('\n').trim()}\n`;
}

export async function writeCoachReport(params: {
  markdown: string;
  reportsDir?: string;
  generatedAt?: Date;
  /** The workflow run that produced this report; embedded in the filename so a report traces to its run. */
  runId?: string;
}): Promise<string> {
  const reportsDir = params.reportsDir ?? defaultReportsDir();
  const generatedAt = params.generatedAt ?? new Date();
  await mkdir(reportsDir, { recursive: true });
  const stamp = sanitizeFilenamePart(generatedAt.toISOString());
  const runPart = params.runId ? `-${sanitizeFilenamePart(params.runId)}` : '';
  const filename = `${stamp}${runPart}-report.md`;
  const extension = extname(filename);
  const stem = filename.slice(0, -extension.length);
  for (let counter = 1; ; counter += 1) {
    const candidate = counter === 1 ? filename : `${stem}-${counter}${extension}`;
    const path = join(reportsDir, candidate);
    try {
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(params.markdown, 'utf8');
      } finally {
        await handle.close();
      }
      return path;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }
}

export async function listReports(reportsDir = defaultReportsDir()): Promise<ReportListing[]> {
  try {
    const entries = await readdir(reportsDir, { withFileTypes: true });
    const reports = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map(async (entry) => {
          const path = join(reportsDir, entry.name);
          const info = await stat(path);
          return { path, name: basename(path), modifiedAt: info.mtime };
        }),
    );
    return reports.sort(
      (left, right) =>
        right.modifiedAt.getTime() - left.modifiedAt.getTime() ||
        right.name.localeCompare(left.name),
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
