import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildRelationshipReplayManifest } from './evaluations/system-one/shadow-replay-manifest.js';

const { Client } = pg;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function valueFromEnvOrFile(name: string): Promise<string> {
  const direct = process.env[name];
  const file = process.env[`${name}_FILE`];
  if (direct && file) throw new Error(`${name} and ${name}_FILE are mutually exclusive`);
  const value = direct ?? (file ? await readFile(file, 'utf8') : '');
  if (!value.trim()) throw new Error(`${name} or ${name}_FILE is required`);
  return value.trim();
}

async function scopedUuid(name: string): Promise<string> {
  const value = await valueFromEnvOrFile(name);
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID`);
  return value.toLowerCase();
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(6));
}

function countMap(rows: Array<{ key: string; count: string }>): Record<string, number> {
  return Object.fromEntries(rows.map(row => [row.key, Number(row.count)]));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function buildAggregateReport(
  client: pg.Client,
  tenantId: string,
  projectId: string,
  runId: string,
  manifest: Awaited<ReturnType<typeof buildRelationshipReplayManifest>>,
): Promise<Record<string, unknown>> {
  const summary = await client.query<{
    completed_count: string; correct_count: string; accepted_count: string;
    accepted_correct_count: string; input_tokens: string; output_tokens: string;
    cost_usd: string; latency_p50: number | null; latency_p95: number | null;
    latency_max: number | null; baseline_correct_count: string;
  }>(`
    SELECT count(prediction.id)::text AS completed_count,
      count(prediction.id) FILTER (
        WHERE prediction.predicted_relationship = replay.expected_relationship
      )::text AS correct_count,
      count(prediction.id) FILTER (WHERE prediction.accepted_by_gate)::text AS accepted_count,
      count(prediction.id) FILTER (
        WHERE prediction.accepted_by_gate
          AND prediction.predicted_relationship = replay.expected_relationship
      )::text AS accepted_correct_count,
      COALESCE(sum(prediction.input_tokens), 0)::text AS input_tokens,
      COALESCE(sum(prediction.output_tokens), 0)::text AS output_tokens,
      COALESCE(sum(prediction.estimated_cost_usd), 0)::text AS cost_usd,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY prediction.duration_ms) AS latency_p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY prediction.duration_ms) AS latency_p95,
      max(prediction.duration_ms) AS latency_max,
      count(*) FILTER (
        WHERE replay.baseline_relationship = replay.expected_relationship
      )::text AS baseline_correct_count
    FROM public.relationship_shadow_replay_cases replay
    LEFT JOIN public.relationship_shadow_queue queue
      ON queue.replay_case_id = replay.id AND queue.tenant_id = replay.tenant_id
     AND queue.project_id = replay.project_id
    LEFT JOIN public.relationship_shadow_predictions prediction
      ON prediction.queue_id = queue.id AND prediction.run_id = $3::uuid
    WHERE replay.tenant_id = $1::uuid AND replay.project_id = $2::uuid
      AND replay.import_batch = $4::text
  `, [tenantId, projectId, runId, manifest.importBatch]);
  const row = summary.rows[0];
  const completed = Number(row.completed_count);
  const correct = Number(row.correct_count);
  const accepted = Number(row.accepted_count);
  const acceptedCorrect = Number(row.accepted_correct_count);
  const expected = manifest.cases.length;

  const confusionRows = await client.query<{
    source: 'baseline' | 'jev'; expected: string; predicted: string; count: string;
  }>(`
    SELECT 'baseline'::text AS source, replay.expected_relationship AS expected,
      replay.baseline_relationship AS predicted, count(*)::text AS count
    FROM public.relationship_shadow_replay_cases replay
    WHERE replay.tenant_id = $1::uuid AND replay.project_id = $2::uuid
      AND replay.import_batch = $4::text
    GROUP BY replay.expected_relationship, replay.baseline_relationship
    UNION ALL
    SELECT 'jev'::text AS source, replay.expected_relationship AS expected,
      prediction.predicted_relationship AS predicted, count(*)::text AS count
    FROM public.relationship_shadow_replay_cases replay
    JOIN public.relationship_shadow_queue queue ON queue.replay_case_id = replay.id
    JOIN public.relationship_shadow_predictions prediction
      ON prediction.queue_id = queue.id AND prediction.run_id = $3::uuid
    WHERE replay.tenant_id = $1::uuid AND replay.project_id = $2::uuid
      AND replay.import_batch = $4::text
    GROUP BY replay.expected_relationship, prediction.predicted_relationship
    ORDER BY source, expected, predicted
  `, [tenantId, projectId, runId, manifest.importBatch]);

  const attemptRows = await client.query<{ key: string; count: string }>(`
    SELECT status AS key, count(*)::text AS count
    FROM public.relationship_shadow_http_attempts
    WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND run_id = $3::uuid
    GROUP BY status ORDER BY status
  `, [tenantId, projectId, runId]);
  const attemptTotals = await client.query<{
    attempt_count: string; reserved_input_tokens: string; reserved_cost_usd: string;
    actual_usage_known_attempts: string; actual_input_tokens: string;
    actual_output_tokens: string; actual_cost_usd: string;
  }>(`
    SELECT count(*)::text AS attempt_count,
      COALESCE(sum(reserved_input_tokens), 0)::text AS reserved_input_tokens,
      COALESCE(sum(reserved_cost_usd), 0)::text AS reserved_cost_usd,
      count(*) FILTER (
        WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR actual_cost_usd IS NOT NULL
      )::text AS actual_usage_known_attempts,
      COALESCE(sum(input_tokens), 0)::text AS actual_input_tokens,
      COALESCE(sum(output_tokens), 0)::text AS actual_output_tokens,
      COALESCE(sum(actual_cost_usd), 0)::text AS actual_cost_usd
    FROM public.relationship_shadow_http_attempts
    WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND run_id = $3::uuid
  `, [tenantId, projectId, runId]);
  const queueRows = await client.query<{ key: string; count: string }>(`
    SELECT COALESCE(last_error_class, status) AS key, count(*)::text AS count
    FROM public.relationship_shadow_queue
    WHERE tenant_id = $1::uuid AND project_id = $2::uuid
      AND import_batch = $3::text
    GROUP BY COALESCE(last_error_class, status) ORDER BY 1
  `, [tenantId, projectId, manifest.importBatch]);
  const predictionHashes = await client.query<{ case_id: string; prediction_sha256: string }>(`
    SELECT case_id, prediction_sha256
    FROM public.relationship_shadow_predictions
    WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND run_id = $3::uuid
    ORDER BY case_id
  `, [tenantId, projectId, runId]);
  const predictionSetSha256 = predictionHashes.rowCount === 0 ? null : createHash('sha256')
    .update(predictionHashes.rows.map(value => `${value.case_id}:${value.prediction_sha256}`).join('\n'))
    .digest('hex');

  const replayEvidence = await client.query<{
    case_id: string; import_batch: string; source_content: string; target_content: string;
    expected_relationship: string; baseline_relationship: string;
    conditional_constraints: unknown; fixture_sha256: string; baseline_sha256: string;
    fixture_set_sha256: string; baseline_set_sha256: string;
  }>(`
    SELECT case_id, import_batch, source_content, target_content,
      expected_relationship, baseline_relationship, conditional_constraints,
      fixture_sha256, baseline_sha256, fixture_set_sha256, baseline_set_sha256
    FROM public.relationship_shadow_replay_cases
    WHERE tenant_id = $1::uuid AND project_id = $2::uuid
  `, [tenantId, projectId]);
  const exactManifestByCase = new Map(manifest.cases.map(value => [value.caseId, value]));
  const replayByCase = new Map(replayEvidence.rows.map(value => [value.case_id, value]));
  let manifestEvidenceViolations = replayEvidence.rows
    .filter(value => !exactManifestByCase.has(value.case_id)).length;
  for (const replay of manifest.cases) {
    const stored = replayByCase.get(replay.caseId);
    if (!stored || stored.import_batch !== manifest.importBatch ||
        stored.source_content !== replay.sourceContent || stored.target_content !== replay.targetContent ||
        stored.expected_relationship !== replay.expectedRelationship ||
        stored.baseline_relationship !== replay.baselineRelationship ||
        canonicalJson(stored.conditional_constraints) !== canonicalJson(replay.conditionalConstraints) ||
        stored.fixture_sha256 !== replay.fixtureSha256 || stored.baseline_sha256 !== replay.baselineSha256 ||
        stored.fixture_set_sha256 !== manifest.fixtureSetSha256 ||
        stored.baseline_set_sha256 !== manifest.baselineSetSha256) {
      manifestEvidenceViolations++;
    }
  }

  const integrity = await client.query<{
    cross_scope_rows: string; provenance_violations: string;
    project_memory_count: string; project_relationship_count: string;
    role_has_graph_privilege: boolean;
  }>(`
    SELECT
      ((SELECT count(*) FROM public.relationship_shadow_http_attempts
         WHERE run_id = $3::uuid AND (tenant_id <> $1::uuid OR project_id <> $2::uuid))
       + (SELECT count(*) FROM public.relationship_shadow_predictions
         WHERE run_id = $3::uuid AND (tenant_id <> $1::uuid OR project_id <> $2::uuid)))::text
        AS cross_scope_rows,
      (SELECT count(*)::text FROM public.relationship_shadow_replay_cases replay
       LEFT JOIN public.relationship_shadow_queue queue
         ON queue.replay_case_id = replay.id
        AND queue.tenant_id = replay.tenant_id AND queue.project_id = replay.project_id
       WHERE replay.tenant_id = $1::uuid AND replay.project_id = $2::uuid
         AND (replay.import_batch <> $4::text
           OR queue.id IS NULL OR queue.provenance_kind <> 'curated_replay'
           OR queue.source_memory_id IS NOT NULL OR queue.target_memory_id IS NOT NULL
           OR queue.local_similarity IS NOT NULL OR queue.local_relationship_type IS NOT NULL
           OR queue.local_confidence IS NOT NULL OR queue.local_selected_for_write IS NOT NULL
           OR queue.local_decision_reason IS NOT NULL OR queue.sampling_stratum IS NOT NULL
           OR queue.max_attempts <> 1
           OR queue.question_set <> 'rembr-system-one-j2-2026-09-17'
           OR queue.state_envelope <> 'strip-shared-sentences-v1'
           OR queue.case_id IS DISTINCT FROM replay.case_id
           OR queue.import_batch IS DISTINCT FROM replay.import_batch
           OR queue.expected_relationship IS DISTINCT FROM replay.expected_relationship
           OR queue.fixture_sha256 IS DISTINCT FROM replay.fixture_sha256
           OR queue.baseline_sha256 IS DISTINCT FROM replay.baseline_sha256
           OR queue.conditional_constraints IS DISTINCT FROM replay.conditional_constraints
           OR replay.fixture_set_sha256 <> $5::text OR replay.baseline_set_sha256 <> $6::text))
        AS provenance_violations,
      (SELECT count(*)::text FROM public.memories
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid) AS project_memory_count,
      (SELECT count(*)::text FROM public.memory_relationships relationship
       JOIN public.memories source_memory ON source_memory.id = relationship.source_memory_id
       JOIN public.memories target_memory ON target_memory.id = relationship.target_memory_id
       WHERE source_memory.tenant_id = $1::uuid AND source_memory.project_id = $2::uuid
          OR target_memory.tenant_id = $1::uuid AND target_memory.project_id = $2::uuid)
        AS project_relationship_count,
      (has_table_privilege('rembr_shadow', 'public.memory_relationships', 'INSERT')
       OR has_table_privilege('rembr_shadow', 'public.memory_relationships', 'UPDATE')
       OR has_table_privilege('rembr_shadow', 'public.memory_relationships', 'DELETE'))
        AS role_has_graph_privilege
  `, [tenantId, projectId, runId, manifest.importBatch,
    manifest.fixtureSetSha256, manifest.baselineSetSha256]);
  const checks = integrity.rows[0];
  const reservations = attemptTotals.rows[0];

  return {
    scope: { tenantId, projectId, runId, importBatch: manifest.importBatch },
    evidence: {
      fixtureSetSha256: manifest.fixtureSetSha256,
      baselineSetSha256: manifest.baselineSetSha256,
      predictionSetSha256,
    },
    progress: { expected, completed, completionCoverage: ratio(completed, expected) },
    baseline: {
      correct: Number(row.baseline_correct_count),
      accuracy: ratio(Number(row.baseline_correct_count), expected),
      confusionMatrix: confusionRows.rows.filter(value => value.source === 'baseline')
        .map(value => ({ expected: value.expected, predicted: value.predicted, count: Number(value.count) })),
    },
    jev: {
      correct,
      accuracy: ratio(correct, completed),
      accepted,
      acceptedCoverage: ratio(accepted, expected),
      acceptedPrecision: ratio(acceptedCorrect, accepted),
      confusionMatrix: confusionRows.rows.filter(value => value.source === 'jev')
        .map(value => ({ expected: value.expected, predicted: value.predicted, count: Number(value.count) })),
    },
    latencyMs: { p50: row.latency_p50, p95: row.latency_p95, max: row.latency_max },
    usage: {
      inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
      estimatedCostUsd: Number(row.cost_usd),
    },
    httpAttemptReservations: {
      attemptCount: Number(reservations.attempt_count),
      reservedInputTokens: Number(reservations.reserved_input_tokens),
      reservedCostUsd: Number(reservations.reserved_cost_usd),
      actualUsageKnownAttempts: Number(reservations.actual_usage_known_attempts),
      actualInputTokens: Number(reservations.actual_input_tokens),
      actualOutputTokens: Number(reservations.actual_output_tokens),
      actualCostUsd: Number(reservations.actual_cost_usd),
    },
    attemptsByStatus: countMap(attemptRows.rows),
    queueOutcomesAndErrors: countMap(queueRows.rows),
    integrity: {
      crossScopeRows: Number(checks.cross_scope_rows),
      provenanceViolations: Number(checks.provenance_violations) + manifestEvidenceViolations,
      projectMemoryCount: Number(checks.project_memory_count),
      projectRelationshipCount: Number(checks.project_relationship_count),
      roleHasGraphWritePrivilege: checks.role_has_graph_privilege,
      graphWriteCheckPassed: Number(checks.project_memory_count) === 0 &&
        Number(checks.project_relationship_count) === 0 && !checks.role_has_graph_privilege,
    },
  };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!['bootstrap', 'import', 'activate', 'ramp', 'stop', 'report', 'describe'].includes(command ?? '')) {
    throw new Error('Usage: system-one-shadow-admin <bootstrap|import|activate|ramp|stop|report|describe>');
  }
  const manifest = await buildRelationshipReplayManifest();
  if (command === 'describe') {
    process.stdout.write(JSON.stringify({
      caseCount: manifest.cases.length,
      importBatch: manifest.importBatch,
      fixtureSetSha256: manifest.fixtureSetSha256,
      baselineSetSha256: manifest.baselineSetSha256,
    }, null, 2) + '\n');
    return;
  }
  const connectionString = await valueFromEnvOrFile('SYSTEM_ONE_SHADOW_ADMIN_DATABASE_URL');
  const tenantId = await scopedUuid('SYSTEM_ONE_SHADOW_TENANT_ID');
  const ownerId = await scopedUuid('SYSTEM_ONE_SHADOW_OWNER_USER_ID');
  const projectName = await valueFromEnvOrFile('SYSTEM_ONE_SHADOW_PROJECT_NAME');
  if (projectName.length > 255 || /[\r\n]/.test(projectName)) {
    throw new Error('SYSTEM_ONE_SHADOW_PROJECT_NAME must be one line and at most 255 characters');
  }
  const projectId = command === 'bootstrap' ? null : await scopedUuid('SYSTEM_ONE_SHADOW_PROJECT_ID');
  const runId = ['activate', 'ramp', 'stop', 'report'].includes(command)
    ? await scopedUuid('SYSTEM_ONE_SHADOW_RUN_ID')
    : null;
  const client = new Client({ connectionString, application_name: 'system-one-shadow-admin' });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '2min'`);
    if (command === 'bootstrap') {
      const result = await client.query<{ project_id: string }>(
        `SELECT rembr_admin_bootstrap_relationship_replay_project(
          $1::uuid, $2::uuid, $3::text
        ) AS project_id`,
        [tenantId, ownerId, projectName],
      );
      process.stdout.write(`project_id=${result.rows[0].project_id}\n`);
    } else {
      const scope = await client.query<{ valid: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM public.tenants tenant
          JOIN public.users owner ON owner.tenant_id = tenant.id
          JOIN public.projects project ON project.tenant_id = tenant.id
          JOIN public.project_members member ON member.project_id = project.id
          WHERE tenant.id = $1::uuid AND tenant.status = 'active'
            AND owner.id = $2::uuid AND owner.status = 'active'
            AND project.id = $3::uuid AND project.name = $4::text
            AND NOT project.is_personal AND project.created_by = owner.id
            AND project.owner_id IS NULL AND member.user_id = owner.id
            AND member.role = 'owner' AND member.added_by = owner.id
            AND NOT EXISTS (SELECT 1 FROM public.project_members other
              WHERE other.project_id = project.id AND other.user_id <> owner.id)
            AND NOT EXISTS (SELECT 1 FROM public.memories memory
              WHERE memory.project_id = project.id)
        ) AS valid
      `, [tenantId, ownerId, projectId, projectName]);
      if (!scope.rows[0]?.valid) {
        throw new Error('SYSTEM_ONE_SHADOW_PROJECT_ID is not the configured controlled project');
      }
    }
    if (command === 'import') {
      for (const replay of manifest.cases) {
        await client.query(
          `SELECT rembr_admin_import_relationship_replay_case(
            $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
            $7::text, $8::text, $9::jsonb, $10::text, $11::text, $12::text, $13::text
          )`,
          [tenantId, projectId!, replay.caseId, manifest.importBatch,
            replay.sourceContent, replay.targetContent, replay.expectedRelationship,
            replay.baselineRelationship, JSON.stringify(replay.conditionalConstraints),
            replay.fixtureSha256, replay.baselineSha256,
            manifest.fixtureSetSha256, manifest.baselineSetSha256],
        );
      }
    } else if (command === 'activate') {
      await client.query(
        `SELECT rembr_admin_activate_relationship_replay(
          $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text
        )`,
        [tenantId, projectId!, runId!, manifest.importBatch,
          manifest.fixtureSetSha256, manifest.baselineSetSha256],
      );
    } else if (command === 'ramp') {
      const requestsPerCycle = Number(process.argv[3]);
      if (!Number.isInteger(requestsPerCycle) || requestsPerCycle < 1 || requestsPerCycle > 10) {
        throw new Error('ramp requires an integer requests-per-cycle value from 1 to 10');
      }
      await client.query(
        'SELECT rembr_admin_ramp_relationship_replay($1::uuid, $2::uuid, $3::uuid, $4::integer)',
        [tenantId, projectId!, runId!, requestsPerCycle],
      );
    } else if (command === 'stop') {
      await client.query(
        'SELECT rembr_admin_stop_relationship_replay($1::uuid, $2::uuid, $3::uuid)',
        [tenantId, projectId!, runId!],
      );
    } else if (command === 'report') {
      const report = await buildAggregateReport(client, tenantId, projectId!, runId!, manifest);
      await client.query('COMMIT');
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }
    await client.query('COMMIT');
    process.stdout.write(`${command} complete for ${manifest.importBatch}\n`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'system-one shadow administration failed');
    process.exitCode = 1;
  });
}
