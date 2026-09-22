import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildSelectedFixtures, evaluationRoot, selectedFixtureSet } from './fixture-set.js';
import { JevProvider } from './jev-provider.js';
import { calculateClassification, calculateLatency, calculateTagSlices } from './metrics.js';
import { selectedStateEnvelope } from './state-envelope.js';
import type { ClassificationMetrics, EvaluationCase, EvaluationPrediction, EvaluationSplit, EvaluationSummary } from './types.js';

const OUTPUT_FIELDS: Record<EvaluationCase['task'], string[]> = {
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

function apiKey(): string {
  const fromEnvironment = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  if (process.env.TYPESAFE_KEY_SOURCE === 'clipboard') {
    return execFileSync('pbpaste', [], { encoding: 'utf8', maxBuffer: 16 * 1024 }).trim();
  }
  throw new Error('Set TYPESAFE_API_KEY or TYPESAFE_KEY_SOURCE=clipboard');
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

function metricsFor(cases: EvaluationCase[], predictions: EvaluationPrediction[]): Record<string, ClassificationMetrics> {
  const metrics: Record<string, ClassificationMetrics> = {};
  for (const task of Object.keys(OUTPUT_FIELDS) as EvaluationCase['task'][]) {
    const taskCases = cases.filter(testCase => testCase.task === task);
    const taskPredictions = predictions.filter(prediction => prediction.task === task);
    for (const field of OUTPUT_FIELDS[task]) {
      metrics[`${task}.${field}`] = calculateClassification(taskCases, taskPredictions, field);
    }
  }
  return metrics;
}

async function findBaselinePredictions(
  root: string,
  fixtureHash: string,
): Promise<EvaluationPrediction[] | null> {
  let entries: string[];
  try {
    entries = (await readdir(root)).sort().reverse();
  } catch {
    return null;
  }
  for (const entry of entries) {
    try {
      const directory = resolve(root, entry);
      const summary = JSON.parse(await readFile(resolve(directory, 'summary.json'), 'utf8')) as EvaluationSummary;
      if (summary.provider !== 'rembr-existing' || summary.fixtureHash !== fixtureHash) continue;
      const lines = (await readFile(resolve(directory, 'predictions.jsonl'), 'utf8')).trim().split('\n');
      return lines.filter(Boolean).map(line => JSON.parse(line) as EvaluationPrediction);
    } catch {
      continue;
    }
  }
  return null;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPoints(value: number): string {
  const points = value * 100;
  return `${points >= 0 ? '+' : ''}${points.toFixed(1)} pp`;
}

function renderReport(
  summary: EvaluationSummary,
  baseline: Record<string, ClassificationMetrics> | null,
  split: EvaluationSplit,
  dataDescription: string,
): string {
  const rows = Object.entries(summary.metrics).map(([name, metric]) => {
    const previous = baseline?.[name];
    return `| ${name} | ${metric.count} | ${percent(metric.accuracy)} | ${percent(metric.macroF1)} | ${previous ? percent(previous.accuracy) : 'n/a'} | ${previous ? signedPoints(metric.accuracy - previous.accuracy) : 'n/a'} |`;
  });
  return `# Rembr System-One Evaluation — Jev ${split}

Generated: ${summary.generatedAt}

## Run manifest

| Field | Value |
|---|---|
| Provider | ${summary.provider} |
| Model | ${summary.model} |
| Question set | ${summary.questionSet ?? 'unversioned'} |
| State envelope | ${summary.stateEnvelope ?? 'unversioned'} |
| Git commit | \`${summary.commit}\` |
| Fixture SHA-256 | \`${summary.fixtureHash}\` |
| Split | ${split} |
| Cases | ${summary.caseCount} |
| Predictions | ${summary.predictionCount} |
| Errors | ${summary.errorCount} |
| Input tokens | ${summary.usage?.inputTokens ?? 0} |
| Output tokens | ${summary.usage?.outputTokens ?? 0} |
| Estimated charge | $${(summary.usage?.estimatedCostUsd ?? 0).toFixed(6)} |

## Direct comparison

| Output | Cases | Jev accuracy | Jev macro F1 | Existing accuracy | Accuracy delta |
|---|---:|---:|---:|---:|---:|
${rows.join('\n')}

## End-to-end latency

| Count | Min | p50 | p95 | p99 | Max |
|---:|---:|---:|---:|---:|---:|
| ${summary.latency.count} | ${summary.latency.minMs}ms | ${summary.latency.p50Ms}ms | ${summary.latency.p95Ms}ms | ${summary.latency.p99Ms}ms | ${summary.latency.maxMs}ms |

All submitted cases were ${dataDescription}. Raw probability distributions, confidence values, per-case usage and errors are retained in \`predictions.jsonl\`.
`;
}

async function main(): Promise<void> {
  const split = (process.env.EVALUATION_SPLIT || 'development') as EvaluationSplit;
  if (!['development', 'calibration', 'locked'].includes(split)) throw new Error(`Invalid split: ${split}`);
  if (split === 'locked' && process.env.ALLOW_LOCKED_EVALUATION !== 'true') {
    throw new Error('Locked evaluation requires ALLOW_LOCKED_EVALUATION=true');
  }

  const fixtureSet = selectedFixtureSet();
  const allFixtures = buildSelectedFixtures(fixtureSet);
  const fixtureJson = allFixtures.map(testCase => JSON.stringify(testCase)).join('\n') + '\n';
  const fixtureHash = createHash('sha256').update(fixtureJson).digest('hex');
  const cases = allFixtures.filter(testCase => testCase.split === split);
  const containsSanitised = cases.some(testCase => testCase.dataClassification === 'sanitised');
  if (containsSanitised && process.env.ALLOW_SANITISED_EVALUATION !== 'true') {
    throw new Error('Sanitised evaluation requires ALLOW_SANITISED_EVALUATION=true');
  }

  const provider = new JevProvider(apiKey(), containsSanitised, selectedStateEnvelope());
  const concurrency = Math.max(1, Math.min(16, Number(process.env.EVALUATION_CONCURRENCY) || 8));
  const maximumInputTokens = Math.max(1, Number(process.env.TYPESAFE_MAX_INPUT_TOKENS) || 1_000_000);
  let observedInputTokens = 0;
  let stopped = false;
  const predictions = await mapWithConcurrency(cases, concurrency, async (testCase, index) => {
    if (stopped) {
      return {
        caseId: testCase.id,
        task: testCase.task,
        provider: provider.provider,
        model: provider.model,
        outputs: {},
        durationMs: 0,
        error: `Skipped after ${maximumInputTokens}-input-token safety cap`,
      };
    }
    const prediction = await provider.predict(testCase);
    observedInputTokens += prediction.usage?.inputTokens ?? 0;
    if (observedInputTokens >= maximumInputTokens) stopped = true;
    if ((index + 1) % 25 === 0 || index + 1 === cases.length) {
      process.stderr.write(`completed ${index + 1}/${cases.length}; input tokens ${observedInputTokens}\n`);
    }
    return prediction;
  });

  const usage = predictions.reduce((total, prediction) => ({
    inputTokens: total.inputTokens + (prediction.usage?.inputTokens ?? 0),
    outputTokens: total.outputTokens + (prediction.usage?.outputTokens ?? 0),
    estimatedCostUsd: total.estimatedCostUsd + (prediction.usage?.estimatedCostUsd ?? 0),
  }), { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
  const successfulModel = predictions.find(prediction => !prediction.error)?.model ?? provider.model;
  const summary: EvaluationSummary = {
    generatedAt: new Date().toISOString(),
    provider: provider.provider,
    model: successfulModel,
    questionSet: provider.questionSet,
    stateEnvelope: provider.stateEnvelope,
    commit: currentCommit(),
    fixtureHash,
    caseCount: cases.length,
    predictionCount: predictions.length,
    errorCount: predictions.filter(prediction => prediction.error).length,
    latency: calculateLatency(predictions),
    metrics: metricsFor(cases, predictions),
    slices: calculateTagSlices(cases, predictions, OUTPUT_FIELDS),
    usage: { ...usage, pricePerMillionInputTokens: provider.pricePerMillionInputTokens },
  };

  const root = resolve(process.cwd(), 'evaluation-results', evaluationRoot(fixtureSet));
  const baselinePredictions = await findBaselinePredictions(root, fixtureHash);
  const baselineMetrics = baselinePredictions
    ? metricsFor(cases, baselinePredictions.filter(prediction => cases.some(testCase => testCase.id === prediction.caseId)))
    : null;
  const runId = summary.generatedAt.replace(/[:.]/g, '-');
  const outputDirectory = resolve(root, runId);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDirectory, 'fixtures.jsonl'), cases.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8'),
    writeFile(resolve(outputDirectory, 'predictions.jsonl'), predictions.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8'),
    writeFile(resolve(outputDirectory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8'),
    writeFile(resolve(outputDirectory, 'comparison.json'), JSON.stringify({ baseline: baselineMetrics, jev: summary.metrics }, null, 2) + '\n', 'utf8'),
    writeFile(
      resolve(outputDirectory, 'report.md'),
      renderReport(
        summary,
        baselineMetrics,
        split,
        containsSanitised ? 'human-adjudicated, genericised and PII-screened' : 'synthetic',
      ),
      'utf8',
    ),
  ]);
  process.stdout.write(`${outputDirectory}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
