import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(fileURLToPath(new URL(
  './migrations/033-system-one-live-fallback.sql',
  import.meta.url,
)), 'utf8');
const migrationRunner = readFileSync(fileURLToPath(new URL(
  '../scripts/apply-security-migration.mjs',
  import.meta.url,
)), 'utf8');

describe('System One live preferred-with-fallback migration', () => {
  it('keeps the local path authoritative for every provider failure', () => {
    expect(sql).toContain("v_action TEXT := 'fallback_retained'");
    expect(sql).toContain("ELSIF p_accepted_by_gate THEN");
    expect(sql).toContain("p_predicted_relationship = 'unrelated'");
    expect(sql).toContain("application_action = v_action");
    expect(sql).not.toContain('DELETE FROM public.memory_relationships WHERE ((relationship.source_memory_id');
  });

  it('changes only exact local-inference rows or Jev-owned rows', () => {
    expect(sql).toContain('relationship.evidence IS NOT DISTINCT FROM v_local_evidence');
    expect(sql).toContain("relationship.evidence LIKE 'TypeSafe Jev 1.13.0 accepted %'");
    expect(sql).toContain('manually authored or other subsystem relationships are never replaced');
    expect(sql).toContain('v_queue.target_memory_id, v_queue.source_memory_id');
  });

  it('enforces single attempts and dynamic bounded live budgets', () => {
    expect(sql).toContain("max_attempts, provenance_kind");
    expect(sql).toContain("p_sampling_stratum, 1, 'live_candidate'");
    expect(sql).toContain('v_request_count + 1 > v_max_requests');
    expect(sql).toContain('v_token_count + p_reserved_input_tokens > v_max_tokens');
    expect(sql).toContain('v_cost + p_reserved_cost_usd > v_max_cost');
    expect(sql).toContain('p_max_total_cost_usd > 5.00');
  });

  it('uses deployment activation as the consent boundary while retaining local scans', () => {
    const loader = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.rembr_shadow_load_relationship_pair'),
      sql.indexOf('CREATE OR REPLACE FUNCTION public.rembr_shadow_reserve_http_attempt'),
    );
    expect(loader).toContain("allowlist.cohort = 'live'");
    expect(loader).toContain('source_memory.pii_detected IS NOT TRUE');
    expect(loader).not.toContain('external_processing_allowed');
    expect(sql).toContain('rembr_admin_activate_relationship_live');
    expect(sql).toContain('FROM PUBLIC, rembr_app, rembr_shadow');
  });

  it('is applied by the production migration runner after the replay migration', () => {
    expect(migrationRunner).toContain("033-system-one-live-fallback.sql");
    expect(migrationRunner.indexOf('await client.query(shadowActivationSql)'))
      .toBeLessThan(migrationRunner.indexOf('await client.query(systemOneLiveSql)'));
  });
});
