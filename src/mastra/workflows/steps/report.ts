import { createStep } from '@mastra/core/workflows';

import { renderCoachReportMarkdown, writeCoachReport } from '../../reporting';
import { coachedInterviewStateSchema, reportedInterviewStateSchema } from '../interview-state';

export const reportStep = createStep({
  id: 'report',
  inputSchema: coachedInterviewStateSchema,
  outputSchema: reportedInterviewStateSchema,
  execute: async ({ inputData }) => {
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
    const reportPath = await writeCoachReport({ markdown, generatedAt });
    return { ...inputData, reportPath, reportGeneratedAt: generatedAt.toISOString() };
  },
});
