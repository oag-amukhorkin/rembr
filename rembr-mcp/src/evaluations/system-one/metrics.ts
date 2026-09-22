import type {
  ClassificationMetrics,
  EvaluationCase,
  EvaluationPrediction,
  EvaluationSplit,
  LatencyMetrics,
} from './types.js';

function round(value: number): number {
  return Number(value.toFixed(6));
}

function percentile(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil((value / 100) * sorted.length) - 1);
  return sorted[index];
}

export function calculateLatency(predictions: EvaluationPrediction[]): LatencyMetrics {
  const values = predictions
    .filter(prediction => !prediction.error)
    .map(prediction => prediction.durationMs)
    .sort((left, right) => left - right);
  return {
    count: values.length,
    minMs: values[0] ?? 0,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
    maxMs: values.at(-1) ?? 0,
  };
}

export function calculateClassification(
  cases: EvaluationCase[],
  predictions: EvaluationPrediction[],
  field: string,
): ClassificationMetrics {
  const predictionByCase = new Map(predictions.map(prediction => [prediction.caseId, prediction]));
  const labels = new Set<string>();
  const rows: Array<{ expected: string; predicted: string }> = [];

  for (const testCase of cases) {
    const expected = testCase.expected[field];
    const prediction = predictionByCase.get(testCase.id);
    if (expected === undefined || prediction?.error) continue;
    const predicted = prediction?.outputs[field] ?? '__missing__';
    labels.add(expected);
    labels.add(predicted);
    rows.push({ expected, predicted });
  }

  const orderedLabels = [...labels].sort();
  const matrix: Record<string, Record<string, number>> = {};
  for (const expected of orderedLabels) {
    matrix[expected] = Object.fromEntries(orderedLabels.map(predicted => [predicted, 0]));
  }
  for (const row of rows) matrix[row.expected][row.predicted]++;

  const perClass: ClassificationMetrics['perClass'] = {};
  for (const label of orderedLabels) {
    const truePositive = matrix[label]?.[label] ?? 0;
    const support = Object.values(matrix[label] ?? {}).reduce((sum, count) => sum + count, 0);
    const predictedCount = orderedLabels.reduce(
      (sum, expected) => sum + (matrix[expected]?.[label] ?? 0),
      0,
    );
    const precision = predictedCount === 0 ? 0 : truePositive / predictedCount;
    const recall = support === 0 ? 0 : truePositive / support;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    perClass[label] = {
      support,
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
    };
  }

  const correct = rows.filter(row => row.expected === row.predicted).length;
  const evaluatedClasses = Object.values(perClass).filter(item => item.support > 0);
  const macroF1 = evaluatedClasses.length === 0
    ? 0
    : evaluatedClasses.reduce((sum, item) => sum + item.f1, 0) / evaluatedClasses.length;

  return {
    field,
    count: rows.length,
    correct,
    accuracy: rows.length === 0 ? 0 : round(correct / rows.length),
    macroF1: round(macroF1),
    perClass,
    confusionMatrix: matrix,
  };
}

export function filterCases(
  cases: EvaluationCase[],
  options: { task?: EvaluationCase['task']; split?: EvaluationSplit; tag?: string },
): EvaluationCase[] {
  return cases.filter(testCase =>
    (!options.task || testCase.task === options.task)
    && (!options.split || testCase.split === options.split)
    && (!options.tag || testCase.tags.includes(options.tag))
  );
}

export function calculateTagSlices(
  cases: EvaluationCase[],
  predictions: EvaluationPrediction[],
  fieldsByTask: Record<EvaluationCase['task'], string[]>,
): Record<string, Record<string, ClassificationMetrics>> {
  const slices: Record<string, Record<string, ClassificationMetrics>> = {};
  const tags = [...new Set(cases.flatMap(testCase => testCase.tags))].sort();
  for (const tag of tags) {
    const taggedCases = cases.filter(testCase => testCase.tags.includes(tag));
    const caseIds = new Set(taggedCases.map(testCase => testCase.id));
    const taggedPredictions = predictions.filter(prediction => caseIds.has(prediction.caseId));
    const sliceMetrics: Record<string, ClassificationMetrics> = {};
    for (const task of Object.keys(fieldsByTask) as EvaluationCase['task'][]) {
      const taskCases = taggedCases.filter(testCase => testCase.task === task);
      if (taskCases.length === 0) continue;
      const taskPredictions = taggedPredictions.filter(prediction => prediction.task === task);
      for (const field of fieldsByTask[task]) {
        sliceMetrics[`${task}.${field}`] = calculateClassification(taskCases, taskPredictions, field);
      }
    }
    slices[tag] = sliceMetrics;
  }
  return slices;
}
