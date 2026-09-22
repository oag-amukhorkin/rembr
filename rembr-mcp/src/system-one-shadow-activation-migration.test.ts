import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(fileURLToPath(new URL(
  './migrations/032-system-one-shadow-activation.sql',
  import.meta.url,
)), 'utf8');
const admin = readFileSync(fileURLToPath(new URL(
  './system-one-shadow-admin.ts',
  import.meta.url,
)), 'utf8');

describe('System One activation migration contract', () => {
  it('reserves every HTTP attempt against exact hard limits', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS relationship_shadow_http_attempts');
    expect(sql).toContain('v_request_count + 1 > 100');
    expect(sql).toContain('v_token_count + p_reserved_input_tokens > 225000');
    expect(sql).toContain('v_cost + p_reserved_cost_usd > 0.02');
    expect(sql).toContain('attempt_number SMALLINT NOT NULL CHECK (attempt_number = 1)');
  });

  it('rejects overlength inputs without truncating and pins completion fields', () => {
    const loader = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION rembr_shadow_load_relationship_pair'),
      sql.indexOf('DROP FUNCTION IF EXISTS rembr_shadow_get_relationship_budget'));
    expect(loader).not.toMatch(/\bleft\s*\(/i);
    expect(loader).toContain('char_length(source_memory.content) <= allowlist.max_content_chars');
    expect(sql).toContain("p_provider <> 'typesafe-system-one'");
    expect(sql).toContain("p_requested_model <> 'jev-1.13.0'");
    expect(sql).toContain('p_request_attempts <> 1');
    expect(sql).toContain('p_accepted_by_gate IS DISTINCT FROM (p_confidence >= 0.8)');
  });

  it('keeps importer, activation, ramp and stop owner-only and idempotent', () => {
    expect(sql).toContain('rembr_admin_bootstrap_relationship_replay_project');
    expect(sql).toContain('rembr_admin_import_relationship_replay_case');
    expect(sql).toContain('replay case hash lock differs');
    expect(sql).toContain('expected_relationship = p_expected_relationship');
    expect(sql).toContain('conditional_constraints IS NOT DISTINCT FROM p_conditional_constraints');
    expect(sql).toContain('activation requires exactly 100 hash-locked replay cases');
    expect(sql).toContain('ramp requires one to three clean completed attempts');
    expect(sql).toContain("EXECUTE 'ALTER ROLE rembr_shadow NOLOGIN'");
    expect(sql).toContain('FROM PUBLIC, rembr_app, rembr_shadow');
  });

  it('keeps deployment identity out of the shared migration', () => {
    expect(sql).toContain('rembr_admin_bootstrap_relationship_replay_project(\n  p_tenant_id UUID, p_owner_user_id UUID, p_project_name TEXT');
    expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
    expect(sql).toContain('replay project name is not unique within tenant');
    expect(sql).toContain('gen_random_uuid(), p_tenant_id, p_project_name');
    expect(sql).toContain('VALUES (gen_random_uuid(), v_project.id, p_owner_user_id');
  });

  it('provides aggregate baseline-versus-Jev reporting and integrity checks', () => {
    for (const contract of [
      'acceptedCoverage', 'acceptedPrecision', 'confusionMatrix',
      'latencyMs', 'inputTokens', 'estimatedCostUsd', 'attemptsByStatus',
      'httpAttemptReservations', 'reservedInputTokens', 'actualUsageKnownAttempts',
      'fixtureSetSha256', 'baselineSetSha256', 'predictionSetSha256',
      'crossScopeRows', 'provenanceViolations', 'graphWriteCheckPassed',
    ]) expect(admin).toContain(contract);
    expect(admin).toContain('queue.expected_relationship IS DISTINCT FROM replay.expected_relationship');
    expect(admin).toContain('queue.conditional_constraints IS DISTINCT FROM replay.conditional_constraints');
    expect(admin).toContain("'report'");
  });
});
