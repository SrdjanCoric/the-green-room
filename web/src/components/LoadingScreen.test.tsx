import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LoadingScreen } from './LoadingScreen';

/** The stage states as rendered, in order: 'active', 'done', or '' (pending). */
function stageStates(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.cues li')).map((li) => li.className);
}

describe('LoadingScreen', () => {
  it('lights the CV stage first, with nothing checked yet', () => {
    const { container } = render(<LoadingScreen cue="Reading your CV" />);
    expect(stageStates(container)).toEqual(['active', '', '']);
  });

  it('advances to the role stage on the ingest progress cue', () => {
    const { container } = render(<LoadingScreen cue="Sizing up the role" />);
    expect(stageStates(container)).toEqual(['done', 'active', '']);
  });

  it('advances to the research stage with the earlier stages checked', () => {
    const { container } = render(<LoadingScreen cue="Researching the company" />);
    expect(stageStates(container)).toEqual(['done', 'done', 'active']);
  });

  it('checks all stages once the run has moved past setup', () => {
    const { container } = render(<LoadingScreen cue="Choosing the next question…" />);
    expect(stageStates(container)).toEqual(['done', 'done', 'done']);
  });

  it('lights nothing before the first cue arrives', () => {
    const { container } = render(<LoadingScreen cue={null} />);
    expect(stageStates(container)).toEqual(['', '', '']);
  });
});
