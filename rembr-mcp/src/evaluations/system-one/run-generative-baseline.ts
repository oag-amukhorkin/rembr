import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildFixtures } from './fixtures.js';
import { ExistingRembrGenerativeProvider } from './generative-baseline-provider.js';
import { calculateClassification, calculateLatency } from './metrics.js';
import type { ClassificationMetrics, EvaluationCase, EvaluationPrediction, EvaluationSummary } from './types.js';

function currentCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function renderReport(summary: EvaluationSummary, predictions: EvaluationPrediction[]): string {
  const generatorCount = predictions.filter(item => item.outputs.decisionPath === 'generator').length;
  const fallbackCount = predictions.filter(item => item.outputs.decisionPath === 'deterministic-fallback').length;
  const rows = Object.entries(summary.metrics).map(([name, metric]) =>
    `| ${name} | ${metric.count} | ${percentage(metric.accuracy)} | ${percentage(metric.macroF1)} |`,
  );
  return `# Rembr System-One Evaluation — Current Generative Components

Generated: ${summary.generatedAt}

This is the B1 production-shaped component baseline on the development split. It calls Rembr's current relationship and contradiction prompts, parsers, timeouts and deterministic fallbacks through \`${summary.model}\`.

## Run manifest

| Field | Value |
|---|---|
| Provider | ${summary.provider} |
| Model | ${summary.model} |
| Git commit | \`${summary.commit}\` |
| Fixture SHA-256 | \`${summary.fixtureHash}\` |
| Split | development |
| Cases | ${summary.caseCount} |
| Predictions | ${summary.predictionCount} |
| Errors | ${summary.errorCount} |
| Generator decisions | ${generatorCount} |
| Deterministic fallbacks | ${fallbackCount} |

## Results

| Output | Cases | Accuracy | Macro F1 |
|---|---:|---:|---:|
${rows.join('\n')}

## End-to-end decision latency

| Count | Min | p50 | p95 | p99 | Max |
|---:|---:|---:|---:|---:|---:|
| ${summary.latency.count} | ${summary.latency.minMs}ms | ${summary.latency.p50Ms}ms | ${summary.latency.p95Ms}ms | ${summary.latency.p99Ms}ms | ${summary.latency.maxMs}ms |

## Scope caveat

The contradiction path is the exact current generator component. The relationship path uses the exact current prompt and parser, with Rembr's local text-similarity score supplied in place of the production embedding similarity. Raw relationship labels and the normalised evaluation label are both retained in \`predictions.jsonl\`. The current production taxonomy cannot emit \`supports\`; this remains visible rather than being hidden by scoring changes.
`;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await operation(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const allFixtures = buildFixtures();
  const fixtureJson = allFixtures.map(testCase => JSON.stringify(testCase)).join('\n') + '\n';
  const fixtureHash = createHash('sha256').update(fixtureJson).digest('hex');
  const cases = allFixtures.filter(testCase =>
    testCase.split === 'development'
    && (testCase.task === 'contradiction' || testCase.task === 'relationship'),
  );
  const concurrency = Math.max(1, Math.min(4, Number(process.env.EVALUATION_CONCURRENCY) || 2));
  const provider = new ExistingRembrGenerativeProvider();
  const predictions = await mapWithConcurrency(cases, concurrency, async (testCase, index) => {
    const prediction = await provider.predict(testCase);
    if ((index + 1) % 20 === 0 || index + 1 === cases.length) {
      process.stderr.write(`completed ${index + 1}/${cases.length}\n`);
    }
    return prediction;
  });

  const metrics: Record<string, ClassificationMetrics> = {};
  for (const [task, field] of [['contradiction', 'contradiction'], ['relationship', 'relationship']] as const) {
    const taskCases = cases.filter(testCase => testCase.task === task);
    const taskPredictions = predictions.filter(prediction => prediction.task === task);
    metrics[`${task}.${field}`] = calculateClassification(taskCases, taskPredictions, field);
  }

  const summary: EvaluationSummary = {
    generatedAt: new Date().toISOString(),
    provider: provider.provider,
    model: provider.model,
    commit: currentCommit(),
    fixtureHash,
    caseCount: cases.length,
    predictionCount: predictions.length,
    errorCount: predictions.filter(prediction => prediction.error).length,
    latency: calculateLatency(predictions),
    metrics,
    slices: {},
  };

  const runId = summary.generatedAt.replace(/[:.]/g, '-');
  const outputDirectory = resolve(process.cwd(), 'evaluation-results', 'system-one', runId);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDirectory, 'fixtures.jsonl'), cases.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8'),
    writeFile(resolve(outputDirectory, 'predictions.jsonl'), predictions.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8'),
    writeFile(resolve(outputDirectory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8'),
    writeFile(resolve(outputDirectory, 'report.md'), renderReport(summary, predictions), 'utf8'),
  ]);
  process.stdout.write(`${outputDirectory}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
