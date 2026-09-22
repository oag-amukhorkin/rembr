import { describe, expect, it } from 'vitest';
import { calculateClassification, calculateLatency, calculateTagSlices } from './metrics.js';
import type { EvaluationCase, EvaluationPrediction } from './types.js';

const cases: EvaluationCase[] = [
  { id: 'one', task: 'contradiction', split: 'development', dataClassification: 'synthetic', input: {}, expected: { contradiction: 'yes' }, tags: [], rationale: '' },
  { id: 'two', task: 'contradiction', split: 'locked', dataClassification: 'synthetic', input: {}, expected: { contradiction: 'no' }, tags: [], rationale: '' },
];

const predictions: EvaluationPrediction[] = [
  { caseId: 'one', task: 'contradiction', provider: 'test', model: 'test', outputs: { contradiction: 'yes' }, durationMs: 1 },
  { caseId: 'two', task: 'contradiction', provider: 'test', model: 'test', outputs: { contradiction: 'yes' }, durationMs: 9 },
];

describe('system-one evaluation metrics', () => {
  it('calculates accuracy, per-class metrics and a confusion matrix', () => {
    const result = calculateClassification(cases, predictions, 'contradiction');
    expect(result.count).toBe(2);
    expect(result.accuracy).toBe(0.5);
    expect(result.confusionMatrix.no.yes).toBe(1);
    expect(result.perClass.yes.precision).toBe(0.5);
    expect(result.perClass.yes.recall).toBe(1);
  });

  it('calculates latency percentiles from successful predictions', () => {
    expect(calculateLatency(predictions)).toMatchObject({ count: 2, minMs: 1, p50Ms: 1, p95Ms: 9, maxMs: 9 });
  });

  it('calculates tagged metrics without mixing unrelated cases', () => {
    const taggedCases: EvaluationCase[] = [
      { ...cases[0], id: 'a', split: 'development', expected: { contradiction: 'yes' }, tags: ['hard-positive'] },
      { ...cases[1], id: 'b', split: 'development', expected: { contradiction: 'no' }, tags: ['hard-negative'] },
    ];
    const taggedPredictions: EvaluationPrediction[] = [
      { ...predictions[0], caseId: 'a', outputs: { contradiction: 'yes' }, durationMs: 10 },
      { ...predictions[1], caseId: 'b', outputs: { contradiction: 'yes' }, durationMs: 20 },
    ];
    const slices = calculateTagSlices(taggedCases, taggedPredictions, {
      query_intent: ['category', 'intent'],
      content_importance: ['importance'],
      contradiction: ['contradiction'],
      relationship: ['relationship'],
    });
    expect(slices['hard-positive']['contradiction.contradiction'].accuracy).toBe(1);
    expect(slices['hard-negative']['contradiction.contradiction'].accuracy).toBe(0);
  });
});
