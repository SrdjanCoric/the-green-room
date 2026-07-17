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

  it('advances the setup cue to the role stage on the ingest progress chunk', () => {
    const interp = createChunkInterpreter();
    interp.next(workflowStep('ingest'));

    const enveloped: StreamChunk = {
      from: 'USER',
      type: 'workflow-step-output',
      payload: { output: { type: 'ingest-progress', stage: 'role' } },
    };
    expect(interp.next(enveloped)).toEqual({ type: 'cue', label: 'Sizing up the role' });
  });

  it('ignores an ingest progress chunk whose stage it does not know', () => {
    const interp = createChunkInterpreter();
    interp.next(workflowStep('ingest'));

    const unknownStage: StreamChunk = {
      from: 'USER',
      type: 'workflow-step-output',
      payload: { output: { type: 'ingest-progress', stage: 'something-new' } },
    };
    expect(interp.next(unknownStage)).toBeNull();
  });

  it('cues the wrap-up and routes agent tokens to the closing while the closing step is active', () => {
    const interp = createChunkInterpreter();

    expect(interp.next(workflowStep('closing'))).toEqual({ type: 'cue', label: 'Wrapping up…' });
    expect(interp.next({ from: 'AGENT', type: 'text-start', payload: {} })).toEqual({
      type: 'closing-start',
    });
    expect(interp.next(textDelta('Thanks for walking me '))).toEqual({
      type: 'closing-delta',
      text: 'Thanks for walking me ',
    });
  });

  it('marks the closing settled as soon as the grade step starts', () => {
    const interp = createChunkInterpreter();
    interp.next(workflowStep('closing'));
    interp.next({ from: 'AGENT', type: 'text-start', payload: {} });
    interp.next(textDelta('Thanks for today.'));

    expect(interp.next(workflowStep('grade'))).toEqual({
      type: 'closing-settled',
      cue: 'Grading your answers…',
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

  it('unwraps agent tokens forwarded through a workflow-step-output envelope', () => {
    const interp = createChunkInterpreter();
    interp.next(workflowStep('interviewTurn'));

    const enveloped: StreamChunk = {
      from: 'USER',
      type: 'workflow-step-output',
      payload: {
        output: { from: 'AGENT', type: 'text-delta', payload: { text: 'Walk me ' } },
        stepName: 'interviewTurn',
      },
    };
    expect(interp.next(enveloped)).toEqual({ type: 'question-delta', text: 'Walk me ' });
  });

  it('signals a question restart when a new reply opens mid-turn', () => {
    const interp = createChunkInterpreter();
    interp.next(workflowStep('interviewTurn'));

    expect(interp.next({ from: 'AGENT', type: 'text-start', payload: {} })).toEqual({
      type: 'question-start',
    });
    // Outside a token-bearing step, a text-start carries no UI signal.
    interp.next(workflowStep('research'));
    expect(interp.next({ from: 'AGENT', type: 'text-start', payload: {} })).toBeNull();
  });

  it('ignores chunks it does not recognise', () => {
    const interp = createChunkInterpreter();

    expect(interp.next({ from: 'WORKFLOW', type: 'mystery', payload: {} })).toBeNull();
    expect(interp.next({ type: 'also-mystery' })).toBeNull();
  });
});
