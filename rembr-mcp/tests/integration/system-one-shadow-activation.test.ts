import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  createDbPool,
  ensureTestDatabase,
} from '../../src/test-utils/test-db.js';
import { buildRelationshipReplayManifest } from '../../src/evaluations/system-one/shadow-replay-manifest.js';
import { buildAggregateReport } from '../../src/system-one-shadow-admin.js';

const databaseName = 'rembr_system_one_activation_regression';
const tenantId = '00000000-0000-4000-8000-000000000101';
const ownerId = '00000000-0000-4000-8000-000000000102';
const runId = '00000000-0000-4000-8000-000000000099';
const projectName = 'System One regression fixture';
let pool: pg.Pool;
let projectId: string;

async function migration(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`../../src/migrations/${name}`, import.meta.url)), 'utf8');
}

describe('System One activation PostgreSQL regression', () => {
  beforeAll(async () => {
    await ensureTestDatabase(databaseName);
    pool = createDbPool(databaseName);
    await pool.query(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO CURRENT_USER;
      GRANT USAGE ON SCHEMA public TO PUBLIC;
      DO $roles$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rembr_app') THEN
          CREATE ROLE rembr_app NOLOGIN;
        END IF;
      END $roles$;
      CREATE TABLE tenants (id UUID PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE users (
        id UUID PRIMARY KEY, tenant_id UUID REFERENCES tenants(id), status TEXT NOT NULL
      );
      CREATE TABLE projects (
        id UUID PRIMARY KEY, tenant_id UUID NOT NULL REFERENCES tenants(id),
        name TEXT NOT NULL, description TEXT, created_by UUID REFERENCES users(id),
        is_personal BOOLEAN NOT NULL DEFAULT FALSE, owner_id UUID,
        UNIQUE (tenant_id, name)
      );
      CREATE TABLE project_members (
        id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id), role TEXT NOT NULL, added_by UUID NOT NULL,
        UNIQUE (project_id, user_id)
      );
      CREATE TABLE memories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
        project_id UUID NOT NULL, content TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        pii_detected BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE memory_relationships (
        source_memory_id UUID NOT NULL, target_memory_id UUID NOT NULL
      );
    `);
    await pool.query(await migration('031-system-one-shadow-pilot.sql'));
    await pool.query(await migration('032-system-one-shadow-activation.sql'));
    await pool.query("INSERT INTO tenants (id, status) VALUES ($1::uuid, 'active')", [tenantId]);
    await pool.query(
      "INSERT INTO users (id, tenant_id, status) VALUES ($1::uuid, $2::uuid, 'active')",
      [ownerId, tenantId],
    );
    const bootstrap = await pool.query<{ project_id: string }>(
      'SELECT rembr_admin_bootstrap_relationship_replay_project($1, $2, $3) AS project_id',
      [tenantId, ownerId, projectName],
    );
    projectId = bootstrap.rows[0].project_id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('fails repeat import closed and reports any queue-to-replay provenance drift', async () => {
    const manifest = await buildRelationshipReplayManifest();
    const replay = manifest.cases[0];
    const importSql = `SELECT rembr_admin_import_relationship_replay_case(
      $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
      $7::text, $8::text, $9::jsonb, $10::text, $11::text, $12::text, $13::text
    )`;
    const valuesFor = (value: typeof replay) => [
      tenantId, projectId, value.caseId, manifest.importBatch,
      value.sourceContent, value.targetContent, value.expectedRelationship,
      value.baselineRelationship, value.conditionalConstraints,
      value.fixtureSha256, value.baselineSha256,
      manifest.fixtureSetSha256, manifest.baselineSetSha256,
    ];

    for (const value of manifest.cases) await pool.query(importSql, valuesFor(value));
    await expect(pool.query(importSql, valuesFor(replay))).resolves.toBeDefined();
    await pool.query(
      `UPDATE relationship_shadow_queue SET expected_relationship =
        CASE WHEN expected_relationship = 'unrelated' THEN 'supports' ELSE 'unrelated' END
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND case_id = $3::text`,
      [tenantId, projectId, replay.caseId],
    );
    await expect(pool.query(importSql, valuesFor(replay)))
      .rejects.toThrow('replay queue hash lock differs');

    const report = await buildAggregateReport(
      pool as unknown as pg.Client,
      tenantId,
      projectId,
      runId,
      manifest,
    );
    expect(report.integrity).toMatchObject({ provenanceViolations: 1 });

    await pool.query(`
      INSERT INTO relationship_shadow_http_attempts (
        queue_id, run_id, tenant_id, project_id, worker_id, attempt_number,
        reserved_input_tokens, reserved_cost_usd, status, requested_at, completed_at
      ) SELECT id, $4::uuid, $1::uuid, $2::uuid, 'integration-regression', 1,
          2250, 0.00009450, 'timeout', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM relationship_shadow_queue
       WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND case_id = $3::text
    `, [tenantId, projectId, replay.caseId, runId]);
    const reportWithFailedAttempt = await buildAggregateReport(
      pool as unknown as pg.Client,
      tenantId,
      projectId,
      runId,
      manifest,
    );
    expect(reportWithFailedAttempt.httpAttemptReservations).toEqual({
      attemptCount: 1,
      reservedInputTokens: 2250,
      reservedCostUsd: 0.0000945,
      actualUsageKnownAttempts: 0,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      actualCostUsd: 0,
    });
    expect(reportWithFailedAttempt.attemptsByStatus).toEqual({ timeout: 1 });
  });
});
