import type { MemoryDatabase } from './database.js';
import {
  scanRelationshipPairForExternalProcessing,
  SystemOneProviderError,
  type SystemOneAttemptCompletion,
  type SystemOneAttemptReservationRequest,
  type SystemOneRelationshipPrediction,
  type SystemOneRelationshipProvider,
} from './system-one-relationship-provider.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RelationshipShadowWorkerConfig {
  tenantId: string;
  projectId: string;
  workerId: string;
  runId: string;
  maxRequestsPerCycle: number;
  leaseSeconds: number;
  maxRetries: 0;
}

export interface RelationshipShadowQueueItem {
  id: string;
  source_memory_id: string | null;
  target_memory_id: string | null;
  question_set: string;
  state_envelope: string;
  attempt_count: number;
  provenance_kind: 'live_candidate' | 'curated_replay';
  case_id: string | null;
}

export interface RelationshipShadowPair {
  source_content: string;
  target_content: string;
  source_metadata: Record<string, unknown>;
  target_metadata: Record<string, unknown>;
}

export interface RelationshipShadowBudget {
  provider_enabled: boolean;
  remaining_requests: number;
  remaining_input_tokens: number;
  remaining_cost_usd: number;
  max_requests_per_cycle: number;
}

export interface RelationshipShadowWorkerRepository {
  claim(config: RelationshipShadowWorkerConfig): Promise<RelationshipShadowQueueItem[]>;
  loadPair(item: RelationshipShadowQueueItem, config: RelationshipShadowWorkerConfig): Promise<RelationshipShadowPair | null>;
  getBudget(config: RelationshipShadowWorkerConfig): Promise<RelationshipShadowBudget | null>;
  reserveAttempt(
    item: RelationshipShadowQueueItem,
    request: SystemOneAttemptReservationRequest,
    config: RelationshipShadowWorkerConfig,
  ): Promise<{ attemptId: string }>;
  finishAttempt(
    completion: SystemOneAttemptCompletion,
    config: RelationshipShadowWorkerConfig,
  ): Promise<void>;
  complete(
    item: RelationshipShadowQueueItem,
    prediction: SystemOneRelationshipPrediction,
    config: RelationshipShadowWorkerConfig,
  ): Promise<void>;
  fail(
    item: RelationshipShadowQueueItem,
    errorClass: string,
    terminal: boolean,
    config: RelationshipShadowWorkerConfig,
  ): Promise<void>;
}

function exactBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function requiredUuid(name: string, value: string | undefined): string {
  if (!value || !UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID`);
  return value.toLowerCase();
}

function boundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function relationshipShadowWorkerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RelationshipShadowWorkerConfig | null {
  const integrationEnabled = exactBoolean(
    'SYSTEM_ONE_INTEGRATION_ENABLED',
    env.SYSTEM_ONE_INTEGRATION_ENABLED,
    false,
  );
  if (!integrationEnabled) return null;
  const providerEnabled = exactBoolean(
    'SYSTEM_ONE_SHADOW_PROVIDER_ENABLED',
    env.SYSTEM_ONE_SHADOW_PROVIDER_ENABLED,
    false,
  );
  const dryRun = exactBoolean('SYSTEM_ONE_SHADOW_DRY_RUN', env.SYSTEM_ONE_SHADOW_DRY_RUN, true);
  if (!providerEnabled || dryRun) return null;
  if (env.DB_USER !== 'rembr_shadow') {
    throw new Error('System One shadow worker requires DB_USER=rembr_shadow');
  }

  return {
    tenantId: requiredUuid('SYSTEM_ONE_SHADOW_TENANT_ID', env.SYSTEM_ONE_SHADOW_TENANT_ID),
    projectId: requiredUuid('SYSTEM_ONE_SHADOW_PROJECT_ID', env.SYSTEM_ONE_SHADOW_PROJECT_ID),
    workerId: (env.SYSTEM_ONE_SHADOW_WORKER_ID || `system-one-shadow-${process.pid}`).slice(0, 128),
    runId: requiredUuid('SYSTEM_ONE_SHADOW_RUN_ID', env.SYSTEM_ONE_SHADOW_RUN_ID),
    maxRequestsPerCycle: boundedInteger(
      'SYSTEM_ONE_SHADOW_MAX_REQUESTS_PER_CYCLE',
      env.SYSTEM_ONE_SHADOW_MAX_REQUESTS_PER_CYCLE,
      1,
      1,
      50,
    ),
    leaseSeconds: boundedInteger(
      'SYSTEM_ONE_SHADOW_LEASE_SECONDS',
      env.SYSTEM_ONE_SHADOW_LEASE_SECONDS,
      900,
      5,
      900,
    ),
    maxRetries: (() => {
      const retries = boundedInteger(
        'SYSTEM_ONE_SHADOW_MAX_RETRIES',
        env.SYSTEM_ONE_SHADOW_MAX_RETRIES,
        0,
        0,
        0,
      );
      return retries as 0;
    })(),
  };
}

export class PostgresRelationshipShadowWorkerRepository implements RelationshipShadowWorkerRepository {
  constructor(private readonly database: MemoryDatabase) {}

  async claim(config: RelationshipShadowWorkerConfig): Promise<RelationshipShadowQueueItem[]> {
    const result = await this.database.query(
      `SELECT * FROM rembr_shadow_claim_relationship_candidates(
        $1::uuid, $2::uuid, $3::text, $4::integer, $5::integer
      )`,
      [config.tenantId, config.projectId, config.workerId, config.maxRequestsPerCycle, config.leaseSeconds],
    );
    return result.rows;
  }

  async loadPair(
    item: RelationshipShadowQueueItem,
    config: RelationshipShadowWorkerConfig,
  ): Promise<RelationshipShadowPair | null> {
    const result = await this.database.query(
      `SELECT * FROM rembr_shadow_load_relationship_pair(
        $1::uuid, $2::uuid, $3::uuid, $4::text
      )`,
      [item.id, config.tenantId, config.projectId, config.workerId],
    );
    return result.rows[0] ?? null;
  }

  async getBudget(config: RelationshipShadowWorkerConfig): Promise<RelationshipShadowBudget | null> {
    const result = await this.database.query(
      `SELECT * FROM rembr_shadow_get_relationship_budget($1::uuid, $2::uuid)`,
      [config.tenantId, config.projectId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      provider_enabled: row.provider_enabled === true,
      remaining_requests: Number(row.remaining_requests),
      remaining_input_tokens: Number(row.remaining_input_tokens),
      remaining_cost_usd: Number(row.remaining_cost_usd),
      max_requests_per_cycle: Number(row.max_requests_per_cycle),
    };
  }

  async reserveAttempt(
    item: RelationshipShadowQueueItem,
    request: SystemOneAttemptReservationRequest,
    config: RelationshipShadowWorkerConfig,
  ): Promise<{ attemptId: string }> {
    const result = await this.database.query(
      `SELECT rembr_shadow_reserve_http_attempt(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text,
        $6::smallint, $7::integer, $8::numeric, $9::timestamptz
      ) AS attempt_id`,
      [
        item.id,
        config.runId,
        config.tenantId,
        config.projectId,
        config.workerId,
        request.attemptNumber,
        request.conservativeInputTokens,
        request.conservativeCostUsd,
        request.requestedAt,
      ],
    );
    const attemptId = result.rows[0]?.attempt_id;
    if (!attemptId) throw new Error('relationship shadow attempt admission was rejected');
    return { attemptId: String(attemptId) };
  }

  async finishAttempt(
    completion: SystemOneAttemptCompletion,
    config: RelationshipShadowWorkerConfig,
  ): Promise<void> {
    const result = await this.database.query(
      `SELECT rembr_shadow_finish_http_attempt(
        $1::uuid, $2::uuid, $3::uuid, $4::text, $5::timestamptz,
        $6::integer, $7::integer, $8::integer, $9::numeric
      ) AS finished`,
      [
        completion.attemptId,
        config.tenantId,
        config.projectId,
        completion.outcome,
        completion.completedAt,
        completion.httpStatus,
        completion.inputTokens,
        completion.outputTokens,
        completion.actualCostUsd,
      ],
    );
    if (result.rows[0]?.finished !== true) {
      throw new Error('relationship shadow attempt finalisation was rejected');
    }
  }

  async complete(
    item: RelationshipShadowQueueItem,
    prediction: SystemOneRelationshipPrediction,
    config: RelationshipShadowWorkerConfig,
  ): Promise<void> {
    const result = await this.database.query(
      `SELECT rembr_shadow_complete_relationship_prediction(
        $1::uuid, $2::uuid, $3::smallint, $4::uuid, $5::uuid,
        $6::text, $7::text, $8::text, $9::text, $10::text,
        $11::jsonb, $12::double precision, $13::boolean,
        $14::text, $15::text, $16::integer, $17::smallint,
        $18::text, $19::integer, $20::integer, $21::numeric,
        $22::timestamptz, $23::timestamptz, $24::uuid, $25::text
      ) AS prediction_id`,
      [
        item.id,
        config.runId,
        0,
        config.tenantId,
        config.projectId,
        config.workerId,
        prediction.provider,
        prediction.requestedModel,
        prediction.returnedModel,
        prediction.label,
        JSON.stringify(prediction.probabilities),
        prediction.confidence,
        prediction.acceptedByGate,
        prediction.rawContentSha256,
        prediction.cleanedContentSha256,
        prediction.durationMs,
        prediction.requestAttempts,
        prediction.httpResultClass,
        prediction.inputTokens,
        prediction.outputTokens,
        prediction.estimatedCostUsd,
        prediction.requestedAt,
        prediction.completedAt,
        prediction.attemptReservationId,
        prediction.predictionSha256,
      ],
    );
    if (!result.rows[0]?.prediction_id) {
      throw new Error('relationship shadow prediction completion was rejected');
    }
  }

  async fail(
    item: RelationshipShadowQueueItem,
    errorClass: string,
    terminal: boolean,
    config: RelationshipShadowWorkerConfig,
  ): Promise<void> {
    const result = await this.database.query(
      `SELECT rembr_shadow_fail_relationship_candidate(
        $1::uuid, $2::uuid, $3::uuid, $4::text,
        $5::boolean, $6::text, $7::integer
      ) AS failed`,
      [item.id, config.tenantId, config.projectId, config.workerId, terminal, errorClass, 30],
    );
    if (result.rows[0]?.failed !== true) {
      throw new Error('relationship shadow failure finalisation was rejected');
    }
  }
}

function conservativeInputTokenUpperBound(pair: RelationshipShadowPair): number {
  // UTF-8 bytes are a deliberately conservative upper bound for ordinary BPE
  // tokenisation. The extra allowance covers the frozen rubric and JSON shape.
  return Buffer.byteLength(pair.source_content, 'utf8') +
    Buffer.byteLength(pair.target_content, 'utf8') + 2_000;
}

export class RelationshipShadowWorker {
  constructor(
    private readonly repository: RelationshipShadowWorkerRepository,
    private readonly provider: Pick<SystemOneRelationshipProvider, 'predict'>,
    readonly config: RelationshipShadowWorkerConfig,
  ) {}

  async runOnce(): Promise<{ claimed: number; succeeded: number; failed: number; skipped: number }> {
    const initialBudget = await this.repository.getBudget(this.config);
    if (!initialBudget?.provider_enabled || initialBudget.remaining_requests <= 0 ||
        initialBudget.remaining_input_tokens <= 0 || initialBudget.remaining_cost_usd <= 0) {
      return { claimed: 0, succeeded: 0, failed: 0, skipped: 0 };
    }

    // The manifest starts at one. A reviewed owner-only DB function may raise
    // this run-level value after 1-3 clean results without restarting the pod
    // (which would deliberately erase its tmpfs credentials).
    const cycleLimit = initialBudget.max_requests_per_cycle;
    if (!Number.isInteger(cycleLimit) || cycleLimit < 1 || cycleLimit > 10) {
      throw new Error('database returned an invalid relationship shadow cycle limit');
    }
    const items = await this.repository.claim({ ...this.config, maxRequestsPerCycle: cycleLimit });
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    // Sequential processing is intentional for the first pilot. It is below the
    // concurrency-two ceiling and makes the pre-admission budget check exact.
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      const item = items[itemIndex];
      const pair = await this.repository.loadPair(item, this.config);
      if (!pair) {
        await this.repository.fail(item, 'eligibility_scope_rejected', true, this.config);
        skipped++;
        continue;
      }
      const scan = scanRelationshipPairForExternalProcessing(pair.source_content, pair.target_content);
      if (!scan.allowed) {
        await this.repository.fail(item, `local_${scan.reason || 'scan_rejected'}`, true, this.config);
        skipped++;
        continue;
      }

      const budget = await this.repository.getBudget(this.config);
      const conservativeTokens = conservativeInputTokenUpperBound(pair);
      const conservativeCost = conservativeTokens / 1_000_000 * 0.042;
      if (!budget?.provider_enabled || budget.remaining_requests < 1 ||
          budget.remaining_input_tokens < conservativeTokens ||
          budget.remaining_cost_usd < conservativeCost) {
        await this.repository.fail(item, 'budget_precheck_rejected', true, this.config);
        skipped++;
        continue;
      }

      try {
        const prediction = await this.provider.predict(pair.source_content, pair.target_content, {
          reserve: request => this.repository.reserveAttempt(item, request, this.config),
          finish: completion => this.repository.finishAttempt(completion, this.config),
        });
        await this.repository.complete(item, prediction, this.config);
        succeeded++;
      } catch (error) {
        const errorClass = error instanceof SystemOneProviderError
          ? error.errorClass
          : 'worker_error';
        // The locked first pilot permits one queue/HTTP attempt only. Every
        // attempted or rejected item reaches a terminal state for auditability.
        const terminal = true;
        await this.repository.fail(item, errorClass, terminal, this.config);
        failed++;
        if (errorClass === 'circuit_open') {
          // claim() increments attempt_count for the whole batch. Leaving the
          // tail leased would strand it at max_attempts=1 after lease expiry,
          // so terminalise every unattempted claim without another provider
          // call before ending this cycle.
          for (const unattempted of items.slice(itemIndex + 1)) {
            await this.repository.fail(
              unattempted,
              'circuit_open_unattempted',
              true,
              this.config,
            );
            skipped++;
          }
          break;
        }
      }
    }

    return { claimed: items.length, succeeded, failed, skipped };
  }
}
