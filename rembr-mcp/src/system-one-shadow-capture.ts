import { createHash } from 'node:crypto';
import type { MemoryDatabase } from './database.js';
import type { RelationshipCandidateTrace } from './memory-relationship-service.js';

export const SYSTEM_ONE_RELATIONSHIP_QUESTION_SET = 'rembr-system-one-j2-2026-09-17';
export const SYSTEM_ONE_STATE_ENVELOPE = 'strip-shared-sentences-v1';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RelationshipShadowCaptureConfig {
  tenantId: string;
  projectId: string;
  sampleRate: number;
  maxCandidatesPerMemory: number;
}

export interface RelationshipShadowCaptureResult {
  considered: number;
  sampled: number;
  queued: number;
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function requiredUuid(name: string, value: string | undefined): string {
  if (!value || !UUID_PATTERN.test(value)) {
    throw new Error(`${name} must be a UUID when relationship shadow capture is enabled`);
  }
  return value.toLowerCase();
}

function boundedNumber(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function relationshipShadowCaptureConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RelationshipShadowCaptureConfig | null {
  const integrationEnabled = parseBoolean(
    'SYSTEM_ONE_INTEGRATION_ENABLED',
    env.SYSTEM_ONE_INTEGRATION_ENABLED,
    false,
  );
  if (!integrationEnabled) return null;
  const enabled = parseBoolean(
    'SYSTEM_ONE_SHADOW_CAPTURE_ENABLED',
    env.SYSTEM_ONE_SHADOW_CAPTURE_ENABLED,
    false,
  );
  if (!enabled) return null;

  return {
    tenantId: requiredUuid('SYSTEM_ONE_SHADOW_TENANT_ID', env.SYSTEM_ONE_SHADOW_TENANT_ID),
    projectId: requiredUuid('SYSTEM_ONE_SHADOW_PROJECT_ID', env.SYSTEM_ONE_SHADOW_PROJECT_ID),
    sampleRate: boundedNumber(
      'SYSTEM_ONE_SHADOW_SAMPLE_RATE',
      env.SYSTEM_ONE_SHADOW_SAMPLE_RATE,
      1,
      0,
      1,
    ),
    maxCandidatesPerMemory: Math.floor(boundedNumber(
      'SYSTEM_ONE_SHADOW_MAX_CANDIDATES_PER_MEMORY',
      env.SYSTEM_ONE_SHADOW_MAX_CANDIDATES_PER_MEMORY,
      100,
      1,
      100,
    )),
  };
}

export class RelationshipShadowCapture {
  constructor(
    private readonly database: MemoryDatabase,
    readonly config: RelationshipShadowCaptureConfig,
  ) {}

  static fromEnv(database: MemoryDatabase, env: NodeJS.ProcessEnv = process.env): RelationshipShadowCapture | null {
    const config = relationshipShadowCaptureConfigFromEnv(env);
    return config ? new RelationshipShadowCapture(database, config) : null;
  }

  async capture(
    tenantId: string,
    projectId: string | undefined,
    trace: RelationshipCandidateTrace[],
  ): Promise<RelationshipShadowCaptureResult> {
    if (tenantId.toLowerCase() !== this.config.tenantId ||
        projectId?.toLowerCase() !== this.config.projectId) {
      return { considered: 0, sampled: 0, queued: 0 };
    }

    const boundedTrace = trace.slice(0, this.config.maxCandidatesPerMemory);
    const sampledTrace = boundedTrace.filter(candidate => this.isSampled(candidate));
    if (sampledTrace.length === 0) {
      return { considered: boundedTrace.length, sampled: 0, queued: 0 };
    }
    const result = await this.database.query(
      `SELECT rembr_capture_relationship_shadow_candidate(
        $1::uuid, $2::uuid,
        candidate.source_memory_id, candidate.target_memory_id,
        $3::text, $4::text,
        candidate.similarity_score, candidate.local_relationship_type,
        candidate.local_confidence, candidate.selected_for_write,
        candidate.decision_reason, candidate.sampling_stratum
      ) AS queue_id
      FROM jsonb_to_recordset($5::jsonb) AS candidate(
        source_memory_id uuid,
        target_memory_id uuid,
        similarity_score double precision,
        local_relationship_type text,
        local_confidence double precision,
        selected_for_write boolean,
        decision_reason text,
        sampling_stratum text
      )`,
      [
        tenantId,
        projectId,
        SYSTEM_ONE_RELATIONSHIP_QUESTION_SET,
        SYSTEM_ONE_STATE_ENVELOPE,
        JSON.stringify(sampledTrace),
      ],
      tenantId,
    );
    const queued = result.rows.filter((row: { queue_id?: string | null }) => row.queue_id).length;

    return { considered: boundedTrace.length, sampled: sampledTrace.length, queued };
  }

  private isSampled(candidate: RelationshipCandidateTrace): boolean {
    if (this.config.sampleRate >= 1) return true;
    if (this.config.sampleRate <= 0) return false;
    const digest = createHash('sha256')
      .update(candidate.source_memory_id)
      .update('\0')
      .update(candidate.target_memory_id)
      .update('\0')
      .update(candidate.sampling_stratum)
      .digest();
    const bucket = digest.readUInt32BE(0) / 0x1_0000_0000;
    return bucket < this.config.sampleRate;
  }
}
