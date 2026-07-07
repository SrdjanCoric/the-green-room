import { createStep } from '@mastra/core/workflows';

import { renderCoachReportMarkdown, writeCoachReport } from '../../reporting';
import { coachedInterviewStateSchema, reportedInterviewStateSchema } from '../interview-state';

/**
 * Build the report step. `reportsDir` is injectable so tests write into a temp
 * directory instead of the real project-root `data/reports/`; the app default
 * (undefined) lets `writeCoachReport` anchor to the canonical location.
 */
export function createReportStep(options: { reportsDir?: string } = {}) {
  return createStep({
    id: 'report',
    inputSchema: coachedInterviewStateSchema,
    outputSchema: reportedInterviewStateSchema,
    execute: async ({ inputData, runId }) => {
      const generatedAt = new Date();
      const role = inputData.roleContext.company
        ? `${inputData.roleContext.role} @ ${inputData.roleContext.company}`
        : inputData.roleContext.role;
      const markdown = renderCoachReportMarkdown({
        targetLevel: inputData.targetLevel,
        role,
        coaching: inputData.coaching,
        transcript: inputData.transcript,
        generatedAt,
      });
      const reportPath = await writeCoachReport({
        markdown,
        generatedAt,
        runId,
        reportsDir: options.reportsDir,
      });
      return { ...inputData, reportPath, reportGeneratedAt: generatedAt.toISOString() };
    },
  });
}

export const reportStep = createReportStep();
