import type { ClassificationMetrics, EvaluationSummary } from './types.js';

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function metricTable(metrics: Record<string, ClassificationMetrics>): string {
  const lines = [
    '| Output | Cases | Accuracy | Macro F1 |',
    '|---|---:|---:|---:|',
  ];
  for (const [name, metric] of Object.entries(metrics).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`| ${name} | ${metric.count} | ${percentage(metric.accuracy)} | ${percentage(metric.macroF1)} |`);
  }
  return lines.join('\n');
}

function classTable(metric: ClassificationMetrics): string {
  const lines = [
    `### ${metric.field}`,
    '',
    '| Class | Support | Precision | Recall | F1 |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const [label, values] of Object.entries(metric.perClass).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`| ${label} | ${values.support} | ${percentage(values.precision)} | ${percentage(values.recall)} | ${percentage(values.f1)} |`);
  }
  return lines.join('\n');
}

export function renderMarkdown(summary: EvaluationSummary): string {
  const classSections = Object.values(summary.metrics).map(classTable).join('\n\n');
  return `# Rembr System-One Evaluation — Existing Baseline

Generated: ${summary.generatedAt}

This report contains no TypeSafe/Jev results. It freezes the behaviour of the existing Rembr implementation before any external-model evaluation.

## Run manifest

| Field | Value |
|---|---|
| Provider | ${summary.provider} |
| Model/path | ${summary.model} |
| Git commit | \`${summary.commit}\` |
| Fixture SHA-256 | \`${summary.fixtureHash}\` |
| Cases | ${summary.caseCount} |
| Predictions | ${summary.predictionCount} |
| Errors | ${summary.errorCount} |

## Headline results

${metricTable(summary.metrics)}

## In-process decision latency

| Count | Min | p50 | p95 | p99 | Max |
|---:|---:|---:|---:|---:|---:|
| ${summary.latency.count} | ${summary.latency.minMs}ms | ${summary.latency.p50Ms}ms | ${summary.latency.p95Ms}ms | ${summary.latency.p99Ms}ms | ${summary.latency.maxMs}ms |

These timings cover only the decision functions in this baseline. Later provider reports will separate network time, service time and end-to-end time.

## Per-class results

${classSections}

## Interpretation rules

- Jev must be evaluated on the identical fixture hash.
- Question wording and thresholds may use only the development and calibration splits.
- The locked split is evaluated after the decision schema and thresholds are frozen.
- Disagreements must be inspectable at individual-case level in the JSONL result.
- No provider may receive fixtures marked with a disallowed data classification.
`;
}
