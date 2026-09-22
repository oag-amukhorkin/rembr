import { performance } from 'node:perf_hooks';
import { AdvancedAnalyticsService } from '../../advanced-analytics-service.js';
import { MemoryRelationshipService } from '../../memory-relationship-service.js';
import { OllamaClient } from '../../ollama-client.js';
import { RelationshipMaintainerService } from '../../optimization/relationship-maintainer-service.js';
import { ExistingRembrBaselineProvider } from './baseline-provider.js';
import type { EvaluationCase, EvaluationPrediction } from './types.js';

interface LLMContradictionResult {
  isContradiction: boolean;
  confidence: number;
}

interface PrivateAnalyticsService {
  analyzeContradictionWithLLM(
    memoryA: unknown,
    memoryB: unknown,
    tenantId: string,
  ): Promise<LLMContradictionResult | null>;
}

interface LLMRelationshipResult {
  relationshipType: string;
  confidence: number;
}

interface PrivateRelationshipMaintainer {
  assessRelationshipWithLLM(
    source: Record<string, unknown>,
    target: Record<string, unknown>,
    similarity: number,
    tenantId: string,
  ): Promise<LLMRelationshipResult | null>;
}

interface PrivateMemoryRelationshipService {
  textSimilarity(left: string, right: string): number;
}

function normaliseRelationship(value: string): string {
  switch (value) {
    case 'updates':
      return 'refines';
    case 'supersedes':
      return 'supersedes';
    case 'similar':
    case 'related':
    case 'associated':
    case 'prerequisite':
      return 'relates_to';
    case 'contradicts':
      return 'unrelated';
    default:
      return value;
  }
}

/**
 * Calls the exact current Rembr generative decision methods. This deliberately
 * keeps their prompts, parsers, timeouts and fallback behaviour intact.
 *
 * Relationship output is normalised onto the evaluation taxonomy. The current
 * production prompt cannot emit `supports`, so that limitation remains visible
 * in the score. The prompt's similarity input uses Rembr's existing local text
 * similarity because the production embedding service is not part of this
 * isolated component benchmark.
 */
export class ExistingRembrGenerativeProvider {
  readonly provider = 'rembr-existing-generative-components';
  readonly model = process.env.LM_STUDIO_MODEL
    || process.env.OPENAI_COMPATIBLE_TEXT_MODEL
    || process.env.OLLAMA_TEXT_MODEL
    || 'llama3.1:8b';

  private readonly deterministic = new ExistingRembrBaselineProvider();
  private readonly analytics = new AdvancedAnalyticsService(
    { query: async () => ({ rows: [] }) } as never,
    undefined,
  ) as unknown as PrivateAnalyticsService;
  private readonly relationshipMaintainer = new RelationshipMaintainerService(
    { query: async () => ({ rows: [] }) } as never,
    OllamaClient.getInstance(),
  ) as unknown as PrivateRelationshipMaintainer;
  private readonly relationshipSimilarity = new MemoryRelationshipService(
    { query: async () => ({ rows: [] }) } as never,
    { generateEmbedding: async () => [] } as never,
  ) as unknown as PrivateMemoryRelationshipService;

  async predict(testCase: EvaluationCase): Promise<EvaluationPrediction> {
    const started = performance.now();
    try {
      const result = await this.evaluate(testCase);
      return {
        caseId: testCase.id,
        task: testCase.task,
        provider: this.provider,
        model: this.model,
        outputs: result.outputs,
        confidence: result.confidence,
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

  private async evaluate(testCase: EvaluationCase): Promise<{
    outputs: Record<string, string>;
    confidence?: Record<string, number>;
  }> {
    if (testCase.task === 'contradiction') {
      const result = await this.analytics.analyzeContradictionWithLLM(
        testCase.input.memoryA,
        testCase.input.memoryB,
        'system-one-evaluation',
      );
      if (result) {
        return {
          outputs: { contradiction: result.isContradiction ? 'yes' : 'no', decisionPath: 'generator' },
          confidence: { contradiction: result.confidence },
        };
      }
      const fallback = await this.deterministic.predict(testCase);
      return { outputs: { ...fallback.outputs, decisionPath: 'deterministic-fallback' } };
    }

    if (testCase.task === 'relationship') {
      const contentA = String(testCase.input.contentA);
      const contentB = String(testCase.input.contentB);
      const similarity = this.relationshipSimilarity.textSimilarity(contentA, contentB);
      const result = await this.relationshipMaintainer.assessRelationshipWithLLM(
        { id: `${testCase.id}-a`, content: contentA, category: 'facts' },
        { id: `${testCase.id}-b`, content: contentB, category: 'facts' },
        similarity,
        'system-one-evaluation',
      );
      if (result) {
        return {
          outputs: {
            relationship: normaliseRelationship(result.relationshipType),
            relationshipRaw: result.relationshipType,
            decisionPath: 'generator',
          },
          confidence: { relationship: result.confidence },
        };
      }
      const fallback = await this.deterministic.predict(testCase);
      return { outputs: { ...fallback.outputs, decisionPath: 'deterministic-fallback' } };
    }

    const fallback = await this.deterministic.predict(testCase);
    return { outputs: { ...fallback.outputs, decisionPath: 'deterministic' } };
  }
}
