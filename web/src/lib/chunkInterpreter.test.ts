import { describe, expect, it } from 'vitest';

import { createChunkInterpreter, type StreamChunk } from './chunkInterpreter';

function workflowStep(id: string): StreamChunk {
  return { from: 'WORKFLOW', type: 'workflow-step-start', payload: { currentStep: { id } } };
}

function textDelta(text: string): StreamChunk {
  return { from: 'AGENT', type: 'text-delta', payload: { text } };
}

describe('createChunkInterpreter', () => {
  it('maps setup step chunks to the staged cue labels', () => {
    const interp = createChunkInterpreter();

    expect(interp.next(workflowStep('ingest'))).toEqual({ type: 'cue', label: 'Reading your CV' });
    expect(interp.next(workflowStep('research'))).toEqual({
      type: 'cue',
      label: 'Researching the company',
    });
  });

  it('routes agent tokens to the question while an interview turn is active', () => {
    const interp = createChunkInterpreter();
    interp.next(workflowStep('interviewTurn'));

    expect(interp.next(textDelta('Walk me '))).toEqual({ type: 'question-delta', text: 'Walk me ' });
    expect(interp.next(textDelta('through it.'))).toEqual({
      type: 'question-delta',
      text: 'through it.',
    });
  });

  it('routes agent tokens to the report while the coach step is active', () => {
    const interp = createChunkInterpreter();
    interp.next(workflowStep('coach'));

    expect(interp.next(textDelta('You perform'))).toEqual({
      type: 'report-delta',
      text: 'You perform',
    });
  });

  it('ignores agent tokens when no question or report step is active', () => {
    const interp = createChunkInterpreter();
    interp.next(workflowStep('research'));

    expect(interp.next(textDelta('internal'))).toBeNull();
  });

  it('ignores chunks it does not recognise', () => {
    const interp = createChunkInterpreter();

    expect(interp.next({ from: 'WORKFLOW', type: 'mystery', payload: {} })).toBeNull();
    expect(interp.next({ type: 'also-mystery' })).toBeNull();
  });
});
