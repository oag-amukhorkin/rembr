import { performance } from 'node:perf_hooks';
import { AdvancedAnalyticsService } from '../../advanced-analytics-service.js';
import { MemoryRelationshipService } from '../../memory-relationship-service.js';
import { QueryIntentService } from '../../query-intent-service.js';
import { classifyContentImportance, type ContentSource } from '../../smart-compression.js';
import type { EvaluationCase, EvaluationPrediction } from './types.js';

interface PrivateRelationshipService {
  textSimilarity(left: string, right: string): number;
  detectRelationshipType(left: string, right: string): string;
}

interface PrivateAnalyticsService {
  analyzeContradiction(memoryA: unknown, memoryB: unknown): Promise<unknown>;
}

export class ExistingRembrBaselineProvider {
  readonly provider = 'rembr-existing';
  readonly model = 'deterministic-current-code';

  private readonly queryIntent = new QueryIntentService({} as never);
  private readonly relationship = new MemoryRelationshipService(
    { query: async () => ({ rows: [] }) } as never,
    { generateEmbedding: async () => [] } as never,
  ) as unknown as PrivateRelationshipService;
  private readonly analytics = new AdvancedAnalyticsService(
    { query: async () => ({ rows: [] }) } as never,
    undefined,
  ) as unknown as PrivateAnalyticsService;

  async predict(testCase: EvaluationCase): Promise<EvaluationPrediction> {
    const started = performance.now();
    try {
      const outputs = await this.evaluate(testCase);
      return {
        caseId: testCase.id,
        task: testCase.task,
        provider: this.provider,
        model: this.model,
        outputs,
        durationMs: Number((performance.now() - started).toFixed(3)),
      };
    } catch (error) {
      return {
        caseId: testCase.id,
        task: testCase.task,
        provider: this.provider,
        model: this.model,
        outputs: {},
        durationMs: Number((performance.now() - started).toFixed(3)),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async evaluate(testCase: EvaluationCase): Promise<Record<string, string>> {
    switch (testCase.task) {
      case 'query_intent': {
        const result = await this.queryIntent.classifyIntent({ query: String(testCase.input.query) });
        return { category: result.primary_category, intent: result.intent_type };
      }
      case 'content_importance':
        return {
          importance: classifyContentImportance(
            String(testCase.input.content),
            String(testCase.input.source) as ContentSource,
          ),
        };
      case 'contradiction': {
        const result = await this.analytics.analyzeContradiction(
          testCase.input.memoryA,
          testCase.input.memoryB,
        );
        return { contradiction: result ? 'yes' : 'no' };
      }
      case 'relationship': {
        const contentA = String(testCase.input.contentA);
        const contentB = String(testCase.input.contentB);
        const similarity = this.relationship.textSimilarity(contentA, contentB);
        return {
          relationship: similarity < 0.20
            ? 'unrelated'
            : this.relationship.detectRelationshipType(contentA, contentB),
        };
      }
    }
  }
}
