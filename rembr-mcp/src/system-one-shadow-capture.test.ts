import { describe, expect, it, vi } from 'vitest';
import {
  RelationshipShadowCapture,
  relationshipShadowCaptureConfigFromEnv,
} from './system-one-shadow-capture.js';
import type { RelationshipCandidateTrace } from './memory-relationship-service.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';

function trace(overrides: Partial<RelationshipCandidateTrace> = {}): RelationshipCandidateTrace {
  return {
    source_memory_id: '00000000-0000-4000-8000-000000000003',
    target_memory_id: '00000000-0000-4000-8000-000000000004',
    similarity_score: 0.82,
    local_relationship_type: 'relates_to',
    local_confidence: 0.82,
    selected_for_write: true,
    decision_reason: 'selected',
    sampling_stratum: 'local_write',
    ...overrides,
  };
}

describe('relationship shadow capture configuration', () => {
  it('is inert by default', () => {
    expect(relationshipShadowCaptureConfigFromEnv({})).toBeNull();
    expect(relationshipShadowCaptureConfigFromEnv({
      TYPESAFE_API_KEY: 'test',
      SYSTEM_ONE_SHADOW_TENANT_ID: TENANT_ID,
      SYSTEM_ONE_SHADOW_PROJECT_ID: PROJECT_ID,
    })).toBeNull();
    expect(relationshipShadowCaptureConfigFromEnv({
      SYSTEM_ONE_INTEGRATION_ENABLED: 'true',
    })).toBeNull();
  });

  it('requires an exact tenant and project UUID when enabled', () => {
    expect(() => relationshipShadowCaptureConfigFromEnv({
      SYSTEM_ONE_INTEGRATION_ENABLED: 'true',
      SYSTEM_ONE_SHADOW_CAPTURE_ENABLED: 'true',
    })).toThrow('SYSTEM_ONE_SHADOW_TENANT_ID');

    expect(relationshipShadowCaptureConfigFromEnv({
      SYSTEM_ONE_INTEGRATION_ENABLED: 'true',
      SYSTEM_ONE_SHADOW_CAPTURE_ENABLED: 'true',
      SYSTEM_ONE_SHADOW_TENANT_ID: TENANT_ID,
      SYSTEM_ONE_SHADOW_PROJECT_ID: PROJECT_ID,
    })).toEqual({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sampleRate: 1,
      maxCandidatesPerMemory: 100,
    });
  });

  it('rejects ambiguous booleans and out-of-range sampling', () => {
    expect(() => relationshipShadowCaptureConfigFromEnv({
      SYSTEM_ONE_INTEGRATION_ENABLED: 'true',
      SYSTEM_ONE_SHADOW_CAPTURE_ENABLED: 'yes',
    })).toThrow('must be true or false');
    expect(() => relationshipShadowCaptureConfigFromEnv({
      SYSTEM_ONE_INTEGRATION_ENABLED: 'true',
      SYSTEM_ONE_SHADOW_CAPTURE_ENABLED: 'true',
      SYSTEM_ONE_SHADOW_TENANT_ID: TENANT_ID,
      SYSTEM_ONE_SHADOW_PROJECT_ID: PROJECT_ID,
      SYSTEM_ONE_SHADOW_SAMPLE_RATE: '1.1',
    })).toThrow('between 0 and 1');
  });
});

describe('RelationshipShadowCapture', () => {
  it('does no database work outside the exact configured scope', async () => {
    const query = vi.fn();
    const capture = new RelationshipShadowCapture({ query } as any, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sampleRate: 1,
      maxCandidatesPerMemory: 100,
    });

    await expect(capture.capture(
      TENANT_ID,
      '00000000-0000-4000-8000-000000000099',
      [trace()],
    )).resolves.toEqual({ considered: 0, sampled: 0, queued: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  it('passes only IDs and local measurements to the bounded capture function', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ queue_id: 'queue-1' }] });
    const capture = new RelationshipShadowCapture({ query } as any, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sampleRate: 1,
      maxCandidatesPerMemory: 100,
    });

    await expect(capture.capture(TENANT_ID, PROJECT_ID, [trace()])).resolves.toEqual({
      considered: 1,
      sampled: 1,
      queued: 1,
    });
    const [sql, params, tenantContext] = query.mock.calls[0];
    expect(sql).toContain('rembr_capture_relationship_shadow_candidate');
    expect(sql).toContain('jsonb_to_recordset');
    expect(params).toHaveLength(5);
    expect(params).not.toContain('memory content');
    expect(params).not.toContain('evidence');
    expect(String(params[4])).not.toContain('content');
    expect(String(params[4])).not.toContain('evidence');
    expect(tenantContext).toBe(TENANT_ID);
  });

  it('applies a stable content-free sample and a per-memory candidate cap', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ queue_id: null }] });
    const capture = new RelationshipShadowCapture({ query } as any, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sampleRate: 1,
      maxCandidatesPerMemory: 2,
    });
    const traces = [
      trace(),
      trace({ target_memory_id: '00000000-0000-4000-8000-000000000005' }),
      trace({ target_memory_id: '00000000-0000-4000-8000-000000000006' }),
    ];

    await expect(capture.capture(TENANT_ID, PROJECT_ID, traces)).resolves.toEqual({
      considered: 2,
      sampled: 2,
      queued: 0,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
