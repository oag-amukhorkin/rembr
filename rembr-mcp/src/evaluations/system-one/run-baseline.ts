import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExistingRembrBaselineProvider } from './baseline-provider.js';
import { buildSelectedFixtures, evaluationRoot, selectedFixtureSet } from './fixture-set.js';
import { calculateClassification, calculateLatency, calculateTagSlices, filterCases } from './metrics.js';
import { renderMarkdown } from './report.js';
import type { ClassificationMetrics, EvaluationCase, EvaluationSummary } from './types.js';

const OUTPUT_FIELDS: Record<string, string[]> = {
  query_intent: ['category', 'intent'],
  content_importance: ['importance'],
  contradiction: ['contradiction'],
  relationship: ['relationship'],
};

function currentCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const fixtureSet = selectedFixtureSet();
  const fixtures = buildSelectedFixtures(fixtureSet);
  const fixtureJson = fixtures.map(testCase => JSON.stringify(testCase)).join('\n') + '\n';
  const fixtureHash = createHash('sha256').update(fixtureJson).digest('hex');
  const provider = new ExistingRembrBaselineProvider();
  const predictions = [];

  for (const testCase of fixtures) predictions.push(await provider.predict(testCase));

  const metrics: Record<string, ClassificationMetrics> = {};
  for (const [task, fields] of Object.entries(OUTPUT_FIELDS)) {
    const taskCases = filterCases(fixtures, { task: task as EvaluationCase['task'] });
    const taskPredictions = predictions.filter(prediction => prediction.task === task);
    for (const field of fields) {
      metrics[`${task}.${field}`] = calculateClassification(taskCases, taskPredictions, field);
    }
  }

  const summary: EvaluationSummary = {
    generatedAt: new Date().toISOString(),
    provider: provider.provider,
    model: provider.model,
    commit: currentCommit(),
    fixtureHash,
    caseCount: fixtures.length,
    predictionCount: predictions.length,
    errorCount: predictions.filter(prediction => prediction.error).length,
    latency: calculateLatency(predictions),
    metrics,
    slices: calculateTagSlices(fixtures, predictions, OUTPUT_FIELDS as Record<EvaluationCase['task'], string[]>),
  };

  const runId = summary.generatedAt.replace(/[:.]/g, '-');
  const outputDirectory = resolve(process.cwd(), 'evaluation-results', evaluationRoot(fixtureSet), runId);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDirectory, 'fixtures.jsonl'), fixtureJson, 'utf8'),
    writeFile(
      resolve(outputDirectory, 'predictions.jsonl'),
      predictions.map(prediction => JSON.stringify(prediction)).join('\n') + '\n',
      'utf8',
    ),
    writeFile(resolve(outputDirectory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8'),
    writeFile(resolve(outputDirectory, 'report.md'), renderMarkdown(summary), 'utf8'),
  ]);

  process.stdout.write(`${outputDirectory}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
