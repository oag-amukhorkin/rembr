export type EvaluationSplit = 'development' | 'calibration' | 'locked';

export type DataClassification = 'synthetic' | 'sanitised';

export interface EvaluationCase {
  id: string;
  task: 'query_intent' | 'content_importance' | 'contradiction' | 'relationship';
  split: EvaluationSplit;
  dataClassification: DataClassification;
  input: Record<string, unknown>;
  expected: Record<string, string>;
  tags: string[];
  rationale: string;
}

export interface EvaluationPrediction {
  caseId: string;
  task: EvaluationCase['task'];
  provider: string;
  model: string;
  outputs: Record<string, string>;
  confidence?: Record<string, number>;
  probabilities?: Record<string, Record<string, number>>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd?: number;
  };
  durationMs: number;
  error?: string;
}

export interface ClassificationMetrics {
  field: string;
  count: number;
  correct: number;
  accuracy: number;
  macroF1: number;
  perClass: Record<string, {
    support: number;
    precision: number;
    recall: number;
    f1: number;
  }>;
  confusionMatrix: Record<string, Record<string, number>>;
}

export interface LatencyMetrics {
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface EvaluationSummary {
  generatedAt: string;
  provider: string;
  model: string;
  questionSet?: string;
  stateEnvelope?: string;
  commit: string;
  fixtureHash: string;
  caseCount: number;
  predictionCount: number;
  errorCount: number;
  latency: LatencyMetrics;
  metrics: Record<string, ClassificationMetrics>;
  slices: Record<string, Record<string, ClassificationMetrics>>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    pricePerMillionInputTokens: number;
  };
}
