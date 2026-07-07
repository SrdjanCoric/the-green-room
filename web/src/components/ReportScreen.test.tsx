import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { InterviewReport } from '../lib/types';
import { ReportScreen } from './ReportScreen';

const report: InterviewReport = {
  targetLevel: 'staff',
  role: 'Staff Product Engineer',
  company: 'Figma',
  coaching: {
    summary: 'You perform like someone who has done the work.',
    answerAdvice: [
      {
        question: 'The work you are proudest of.',
        diagnosis: 'The scene ends on the plan, not the payoff.',
        fix: 'Close on one quantified result.',
      },
    ],
    drills: [{ focus: 'Landing the last line', exercise: 'Write the single-sentence result.' }],
    studyPlan: 'First priority: every story needs a quantified last line.',
  },
  transcript: [{ question: 'Proudest work?', answer: 'The billing migration.' }],
};

describe('ReportScreen', () => {
  it('renders the director-notes tab by default', () => {
    render(<ReportScreen report={report} />);

    expect(screen.getByText(/you perform like someone/i)).toBeInTheDocument();
    expect(screen.getByText(/the work you are proudest of/i)).toBeInTheDocument();
    expect(screen.getByText(/close on one quantified result/i)).toBeInTheDocument();
    expect(screen.getByText(/landing the last line/i)).toBeInTheDocument();
    expect(screen.getByText(/every story needs a quantified last line/i)).toBeInTheDocument();
  });

  it('switches to the transcript tab', async () => {
    render(<ReportScreen report={report} />);

    expect(screen.queryByText(/the billing migration/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /the script/i }));

    expect(screen.getByText('Proudest work?')).toBeInTheDocument();
    expect(screen.getByText(/the billing migration/i)).toBeInTheDocument();
  });
});
