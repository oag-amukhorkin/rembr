import { describe, expect, it, vi } from 'vitest';
import {
  RelationshipShadowWorker,
  relationshipShadowWorkerConfigFromEnv,
  type RelationshipShadowQueueItem,
  type RelationshipShadowWorkerConfig,
  type RelationshipShadowWorkerRepository,
} from './relationship-shadow-worker.js';
import { SystemOneProviderError } from './system-one-relationship-provider.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const RUN_ID = '00000000-0000-4000-8000-000000000003';

const config: RelationshipShadowWorkerConfig = {
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  workerId: 'worker-test',
  runId: RUN_ID,
  maxRequestsPerCycle: 2,
  leaseSeconds: 30,
  maxRetries: 0,
};

const item: RelationshipShadowQueueItem = {
  id: '00000000-0000-4000-8000-000000000004',
  source_memory_id: '00000000-0000-4000-8000-000000000005',
  target_memory_id: '00000000-0000-4000-8000-000000000006',
  question_set: 'rembr-system-one-j2-2026-09-17',
  state_envelope: 'strip-shared-sentences-v1',
  attempt_count: 1,
  provenance_kind: 'curated_replay',
  case_id: 'boundary-relationship-000-0',
};

function repository(overrides: Partial<RelationshipShadowWorkerRepository> = {}): RelationshipShadowWorkerRepository {
  return {
    claim: vi.fn().mockResolvedValue([item]),
    loadPair: vi.fn().mockResolvedValue({
      source_content: 'The queue has a bounded size.',
      target_content: 'The queue is capped at three hundred items.',
      source_metadata: { external_processing_allowed: true },
      target_metadata: { external_processing_allowed: true },
    }),
    getBudget: vi.fn().mockResolvedValue({
      provider_enabled: true,
      remaining_requests: 300,
      remaining_input_tokens: 250_000,
      remaining_cost_usd: 0.1,
      max_requests_per_cycle: 1,
    }),
    reserveAttempt: vi.fn().mockResolvedValue({
      attemptId: '00000000-0000-4000-8000-000000000099',
    }),
    finishAttempt: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function prediction() {
  return {
    provider: 'typesafe-system-one' as const,
    requestedModel: 'jev-1.13.0' as const,
    returnedModel: 'jev-1.13.0',
    questionSet: 'rembr-system-one-j2-2026-09-17' as const,
    stateEnvelope: 'strip-shared-sentences-v1' as const,
    label: 'refines' as const,
    probabilities: { supports: 0, refines: 1, supersedes: 0, relates_to: 0, unrelated: 0 },
    confidence: 1,
    acceptedByGate: true,
    rawContentSha256: 'a'.repeat(64),
    cleanedContentSha256: 'b'.repeat(64),
    durationMs: 12,
    requestAttempts: 1,
    httpResultClass: '2xx' as const,
    inputTokens: 100,
    outputTokens: 5,
    estimatedCostUsd: 0.0000042,
    requestedAt: new Date('2026-09-18T00:00:00Z'),
    completedAt: new Date('2026-09-18T00:00:01Z'),
    attemptReservationId: '00000000-0000-4000-8000-000000000099',
    predictionSha256: 'c'.repeat(64),
  };
}

describe('relationship shadow worker configuration', () => {
  it('is inert unless provider is enabled and dry-run is explicitly false', () => {
    expect(relationshipShadowWorkerConfigFromEnv({})).toBeNull();
    expect(relationshipShadowWorkerConfigFromEnv({
      TYPESAFE_API_KEY: 'test',
      SYSTEM_ONE_SHADOW_TENANT_ID: TENANT_ID,
      SYSTEM_ONE_SHADOW_PROJECT_ID: PROJECT_ID,
    })).toBeNull();
    expect(relationshipShadowWorkerConfigFromEnv({
      SYSTEM_ONE_INTEGRATION_ENABLED: 'true',
      SYSTEM_ONE_SHADOW_PROVIDER_ENABLED: 'true',
    })).toBeNull();
  });

  it('requires the restricted database role before activation', () => {
    expect(() => relationshipShadowWorkerConfigFromEnv({
      SYSTEM_ONE_INTEGRATION_ENABLED: 'true',
      SYSTEM_ONE_SHADOW_PROVIDER_ENABLED: 'true',
      SYSTEM_ONE_SHADOW_DRY_RUN: 'false',
      DB_USER: 'rembr_app',
    })).toThrow('DB_USER=rembr_shadow');
  });

  it('parses the exact activation scope', () => {
    expect(relationshipShadowWorkerConfigFromEnv({
      SYSTEM_ONE_INTEGRATION_ENABLED: 'true',
      SYSTEM_ONE_SHADOW_PROVIDER_ENABLED: 'true',
      SYSTEM_ONE_SHADOW_DRY_RUN: 'false',
      DB_USER: 'rembr_shadow',
      SYSTEM_ONE_SHADOW_TENANT_ID: TENANT_ID,
      SYSTEM_ONE_SHADOW_PROJECT_ID: PROJECT_ID,
      SYSTEM_ONE_SHADOW_RUN_ID: RUN_ID,
    })).toMatchObject({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      maxRequestsPerCycle: 1,
      leaseSeconds: 900,
      maxRetries: 0,
    });
  });
});

describe('RelationshipShadowWorker', () => {
  it('does not claim work when the database provider gate or budget is closed', async () => {
    const repo = repository({
      getBudget: vi.fn().mockResolvedValue({
        provider_enabled: false,
        remaining_requests: 300,
        remaining_input_tokens: 250_000,
        remaining_cost_usd: 0.1,
        max_requests_per_cycle: 1,
      }),
    });
    const provider = { predict: vi.fn() };
    const worker = new RelationshipShadowWorker(repo, provider as any, config);

    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    });
    expect(repo.claim).not.toHaveBeenCalled();
    expect(provider.predict).not.toHaveBeenCalled();
  });

  it('rejects locally detected PII before calling the provider', async () => {
    const repo = repository({
      loadPair: vi.fn().mockResolvedValue({
        source_content: 'Email owner@example.com before deployment.',
        target_content: 'The deployment is ready.',
        source_metadata: { external_processing_allowed: true },
        target_metadata: { external_processing_allowed: true },
      }),
    });
    const provider = { predict: vi.fn() };
    const worker = new RelationshipShadowWorker(repo, provider as any, config);

    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      failed: 0,
      skipped: 1,
    });
    expect(provider.predict).not.toHaveBeenCalled();
    expect(repo.fail).toHaveBeenCalledWith(item, 'local_pii_detected', true, config);
  });

  it('checks the remaining budget before the provider call', async () => {
    const getBudget = vi.fn()
      .mockResolvedValueOnce({
        provider_enabled: true,
        remaining_requests: 1,
        remaining_input_tokens: 10_000,
        remaining_cost_usd: 0.1,
        max_requests_per_cycle: 1,
      })
      .mockResolvedValueOnce({
        provider_enabled: true,
        remaining_requests: 1,
        remaining_input_tokens: 1,
        remaining_cost_usd: 0.1,
        max_requests_per_cycle: 1,
      });
    const repo = repository({ getBudget });
    const provider = { predict: vi.fn() };
    const worker = new RelationshipShadowWorker(repo, provider as any, config);

    await expect(worker.runOnce()).resolves.toMatchObject({ skipped: 1 });
    expect(provider.predict).not.toHaveBeenCalled();
    expect(repo.fail).toHaveBeenCalledWith(item, 'budget_precheck_rejected', true, config);
  });

  it('stores a successful prediction through the bounded repository function', async () => {
    const repo = repository();
    const result = prediction();
    const provider = {
      predict: vi.fn().mockImplementation(async (_left, _right, hooks) => {
        await hooks.reserve({
          attemptNumber: 1,
          requestedAt: result.requestedAt,
          conservativeInputTokens: 100,
          conservativeCostUsd: 0.0000042,
        });
        await hooks.finish({
          attemptId: result.attemptReservationId,
          outcome: 'succeeded',
          completedAt: result.completedAt,
          httpStatus: 200,
          inputTokens: 100,
          outputTokens: 5,
          actualCostUsd: 0.0000042,
        });
        return result;
      }),
    };
    const worker = new RelationshipShadowWorker(repo, provider as any, config);

    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(repo.complete).toHaveBeenCalledWith(item, result, config);
    expect(repo.reserveAttempt).toHaveBeenCalledTimes(1);
    expect(repo.finishAttempt).toHaveBeenCalledTimes(1);
    expect(repo.fail).not.toHaveBeenCalled();
  });

  it('terminalises every remaining bulk claim when the circuit is open', async () => {
    const items = [0, 1, 2].map(index => ({
      ...item,
      id: `00000000-0000-4000-8000-00000000000${index + 4}`,
      case_id: `boundary-relationship-000-${index}`,
    }));
    const repo = repository({
      claim: vi.fn().mockResolvedValue(items),
      getBudget: vi.fn().mockResolvedValue({
        provider_enabled: true,
        remaining_requests: 100,
        remaining_input_tokens: 225_000,
        remaining_cost_usd: 0.02,
        max_requests_per_cycle: 3,
      }),
    });
    const provider = {
      predict: vi.fn().mockRejectedValue(
        new SystemOneProviderError('circuit_open', 'System One circuit breaker is open'),
      ),
    };
    const worker = new RelationshipShadowWorker(repo, provider, {
      ...config,
      maxRequestsPerCycle: 3,
    });

    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 3,
      succeeded: 0,
      failed: 1,
      skipped: 2,
    });
    expect(provider.predict).toHaveBeenCalledTimes(1);
    expect(repo.fail).toHaveBeenNthCalledWith(1, items[0], 'circuit_open', true, {
      ...config,
      maxRequestsPerCycle: 3,
    });
    expect(repo.fail).toHaveBeenNthCalledWith(2, items[1], 'circuit_open_unattempted', true, {
      ...config,
      maxRequestsPerCycle: 3,
    });
    expect(repo.fail).toHaveBeenNthCalledWith(3, items[2], 'circuit_open_unattempted', true, {
      ...config,
      maxRequestsPerCycle: 3,
    });
  });
});
