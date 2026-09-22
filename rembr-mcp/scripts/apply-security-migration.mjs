#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import pg from 'pg'

const { Client } = pg
const connectionString = process.env.MIGRATION_DATABASE_URL
const appPassword = process.env.DB_APP_PASSWORD || ''
const exporterPassword = process.env.DB_EXPORTER_PASSWORD || ''
async function credentialFromEnvOrFile(name, fileName) {
  const direct = process.env[name] || ''
  const file = process.env[fileName] || ''
  if (direct && file) throw new Error(`${name} and ${fileName} are mutually exclusive`)
  if (!file) return direct
  return (await readFile(file, 'utf8')).trim()
}

const shadowPassword = await credentialFromEnvOrFile('DB_SHADOW_PASSWORD', 'DB_SHADOW_PASSWORD_FILE')
const applyAllMigrations = process.env.APPLY_ALL_MCP_MIGRATIONS === 'true'
const shadowRoleLoginEnabled = process.env.SYSTEM_ONE_SHADOW_ROLE_LOGIN_ENABLED === 'true'

function migrationPasswordFrom(value) {
  if (!value) return ''
  try {
    const parsed = new URL(value)
    return parsed.password ? decodeURIComponent(parsed.password) : ''
  } catch {
    throw new Error('MIGRATION_DATABASE_URL must be a valid URL')
  }
}

const migrationPassword = migrationPasswordFrom(connectionString)

const prerequisiteMigrations = [
  '001-auto-optimization-tables.sql',
  '002-pii-detection.sql',
  '003-file-storage.sql',
  '004-snapshot-immutability.sql',
  '005-encrypt-stripe-customer-ids.sql',
  '006-vector-index-tuning.sql',
  '007-embedding-model-consistency.sql',
  '008-api-key-security.sql',
  '009-stripe-id-protection.sql',
  '010-contextpilot-schema.sql',
  '011-plan-regeneration-schema.sql',
  '012-task-management-schema.sql',
  '012-task-handoff-schema.sql',
  '013-vector-search-adaptive-tuning.sql',
  '014-security-events-table.sql',
  '015-tenant-plan-limits.sql',
  '016-acceptance-criteria-schema.sql',
  '017-audit-logs-mcp-columns.sql',
  '006-audit-tamper-resistance.sql',
  '017-compaction-schedules.sql',
  '018-context-checkpoints-table.sql',
  '019-context-budgets-table.sql',
  '020-engagement-events-table.sql',
  '021_purge_plaintext_oauth_tokens.sql',
  '024-agentic-features-schema.sql',
  '025-agentic-runtime-followups.sql',
  '026-mcp-stateless-protocol.sql',
  '027-memory-maintenance-jobs.sql',
  '028-repair-vector-indexes.sql',
  '029-memory-evolution-jobs.sql',
]

if (!connectionString) {
  throw new Error('MIGRATION_DATABASE_URL is required')
}
if (!/^[A-Fa-f0-9]{64,}$/.test(appPassword)) {
  throw new Error('POSTGRES_APP_PASSWORD must contain at least 64 hexadecimal characters')
}
if (!/^[A-Fa-f0-9]{64,}$/.test(exporterPassword)) {
  throw new Error('POSTGRES_EXPORTER_PASSWORD must contain at least 64 hexadecimal characters')
}
if (appPassword === exporterPassword) {
  throw new Error('application and exporter database passwords must be independent')
}
if (migrationPassword && [appPassword, exporterPassword].includes(migrationPassword)) {
  throw new Error('runtime database passwords must be independent from the migrator password')
}
if (
  process.env.APPLY_ALL_MCP_MIGRATIONS &&
  !['true', 'false'].includes(process.env.APPLY_ALL_MCP_MIGRATIONS)
) {
  throw new Error('APPLY_ALL_MCP_MIGRATIONS must be true or false')
}
if (
  process.env.SYSTEM_ONE_SHADOW_ROLE_LOGIN_ENABLED &&
  !['true', 'false'].includes(process.env.SYSTEM_ONE_SHADOW_ROLE_LOGIN_ENABLED)
) {
  throw new Error('SYSTEM_ONE_SHADOW_ROLE_LOGIN_ENABLED must be true or false')
}
if (shadowRoleLoginEnabled) {
  if (!/^[A-Fa-f0-9]{64,}$/.test(shadowPassword)) {
    throw new Error('DB_SHADOW_PASSWORD must contain at least 64 hexadecimal characters')
  }
  if ([appPassword, exporterPassword, migrationPassword].includes(shadowPassword)) {
    throw new Error('shadow database password must be independent from every other database role')
  }
}

const migrationUrl = new URL('../src/migrations/030-security-boundaries.sql', import.meta.url)
const sql = await readFile(migrationUrl, 'utf8')
const shadowMigrationUrl = new URL('../src/migrations/031-system-one-shadow-pilot.sql', import.meta.url)
const shadowSql = await readFile(shadowMigrationUrl, 'utf8')
const shadowActivationMigrationUrl = new URL('../src/migrations/032-system-one-shadow-activation.sql', import.meta.url)
const shadowActivationSql = await readFile(shadowActivationMigrationUrl, 'utf8')
const systemOneLiveMigrationUrl = new URL('../src/migrations/033-system-one-live-fallback.sql', import.meta.url)
const systemOneLiveSql = await readFile(systemOneLiveMigrationUrl, 'utf8')
const client = new Client({ connectionString, application_name: 'rembr-security-migration' })

try {
  await client.connect()
  await client.query('BEGIN')
  await client.query(`
    SET LOCAL lock_timeout = '30s';
    SET LOCAL statement_timeout = '15min';
    SET LOCAL idle_in_transaction_session_timeout = '16min';
  `)

  if (applyAllMigrations) {
    await client.query(`
      DO $role$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rembr_app') THEN
          CREATE ROLE rembr_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOINHERIT NOBYPASSRLS;
        END IF;
      END
      $role$;
    `)
    for (const filename of prerequisiteMigrations) {
      const prerequisiteUrl = new URL(`../src/migrations/${filename}`, import.meta.url)
      const prerequisiteSql = await readFile(prerequisiteUrl, 'utf8')
      await client.query(prerequisiteSql)
    }
  }

  await client.query(sql)

  const roleSql = await client.query(
    `SELECT format(
      'ALTER ROLE rembr_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
      $1::text
    ) AS statement`,
    [appPassword],
  )
  await client.query(roleSql.rows[0].statement)
  await client.query(`
    DO $role$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rembr_monitor') THEN
        CREATE ROLE rembr_monitor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
          INHERIT NOBYPASSRLS;
      END IF;
    END
    $role$;
  `)
  const exporterRoleSql = await client.query(
    `SELECT format(
      'ALTER ROLE rembr_monitor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS PASSWORD %L',
      $1::text
    ) AS statement`,
    [exporterPassword],
  )
  await client.query(exporterRoleSql.rows[0].statement)
  const databaseGrantSql = await client.query(
    `SELECT format('GRANT CONNECT ON DATABASE %I TO rembr_app', current_database()) AS statement`,
  )
  await client.query(databaseGrantSql.rows[0].statement)
  const monitorDatabaseGrantSql = await client.query(
    `SELECT format('GRANT CONNECT ON DATABASE %I TO rembr_monitor', current_database()) AS statement`,
  )
  await client.query(monitorDatabaseGrantSql.rows[0].statement)
  await client.query(`
    REVOKE CREATE ON SCHEMA public FROM PUBLIC, rembr_app;
    GRANT USAGE ON SCHEMA public TO rembr_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rembr_app;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO rembr_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON TABLES FROM PUBLIC, rembr_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON SEQUENCES FROM PUBLIC, rembr_app;
    REVOKE ALL ON TABLE audit_chain_heads, gdpr_deletion_requests, gdpr_consent_events,
      rembr_security_migration_state
      FROM PUBLIC, rembr_app;
    GRANT SELECT ON TABLE rembr_security_migration_state TO rembr_app;
    REVOKE UPDATE, DELETE ON TABLE audit_logs FROM PUBLIC, rembr_app;
    GRANT SELECT, INSERT ON TABLE audit_logs TO rembr_app;
    DO $private_prisma_ledger$
    BEGIN
      IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON TABLE public._prisma_migrations FROM PUBLIC, rembr_app';
      END IF;
    END
    $private_prisma_ledger$;
    REVOKE CREATE ON SCHEMA public FROM rembr_monitor;
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM rembr_monitor;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM rembr_monitor;
    GRANT pg_monitor TO rembr_monitor;
  `)

  // Apply the inert shadow-pilot boundary after the broad application grants
  // above so migration 031 can explicitly revoke access to its new tables.
  const shadowBoundary = await client.query(
    `SELECT to_regclass('public.relationship_shadow_allowlist') AS allowlist`,
  )
  if (shadowBoundary.rows[0].allowlist === null) {
    await client.query(shadowSql)
  }
  await client.query(shadowActivationSql)
  await client.query(systemOneLiveSql)
  if (shadowRoleLoginEnabled) {
    const shadowRoleSql = await client.query(
      `SELECT format(
        'ALTER ROLE rembr_shadow LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
        $1::text
      ) AS statement`,
      [shadowPassword],
    )
    await client.query(shadowRoleSql.rows[0].statement)
  }

  const verification = await client.query(`
    SELECT
      EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = 'rembr_app' AND rolcanlogin
          AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
          AND NOT rolinherit AND NOT rolbypassrls
      ) AS safe_app_role,
      EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = 'rembr_monitor' AND rolcanlogin
          AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
          AND rolinherit AND NOT rolbypassrls
      ) AND pg_has_role('rembr_monitor', 'pg_monitor', 'member')
        AND NOT has_schema_privilege('rembr_monitor', 'public', 'CREATE')
        AND NOT has_table_privilege('rembr_monitor', 'memories', 'SELECT')
        AS safe_monitor_role,
      COUNT(*) FILTER (
        WHERE c.relname IN (
          'memories', 'causal_relationships', 'temporal_snapshots',
          'rlm_sessions', 'rlm_iterations'
        )
          AND c.relrowsecurity AND c.relforcerowsecurity
      ) = 5 AS force_rls_boundaries,
      to_regprocedure('rembr_lookup_api_key(text)') IS NOT NULL AS api_key_lookup,
      to_regprocedure('rembr_lookup_oauth_token(text)') IS NOT NULL AS oauth_lookup,
      NOT has_schema_privilege('rembr_app', 'public', 'CREATE') AS no_schema_create,
      has_table_privilege('rembr_app', 'users', 'SELECT')
        AND has_table_privilege('rembr_app', 'accounts', 'INSERT')
        AND has_table_privilege('rembr_app', 'api_keys', 'SELECT')
        AND has_table_privilege('rembr_app', 'oauth_tokens', 'UPDATE')
        AND has_table_privilege('rembr_app', 'sessions', 'DELETE')
        AS shared_application_table_access,
      NOT has_table_privilege('rembr_app', 'audit_chain_heads', 'SELECT')
        AND NOT has_table_privilege('rembr_app', 'audit_chain_heads', 'INSERT')
        AND NOT has_table_privilege('rembr_app', 'audit_chain_heads', 'UPDATE')
        AND NOT has_table_privilege('rembr_app', 'audit_chain_heads', 'DELETE')
        AS audit_chain_control_private,
      NOT EXISTS (
        SELECT 1
        FROM unnest(ARRAY['gdpr_deletion_requests', 'gdpr_consent_events']) AS gated(table_name)
        WHERE has_table_privilege('rembr_app', gated.table_name, 'SELECT')
           OR has_table_privilege('rembr_app', gated.table_name, 'INSERT')
           OR has_table_privilege('rembr_app', gated.table_name, 'UPDATE')
           OR has_table_privilege('rembr_app', gated.table_name, 'DELETE')
      ) AS gdpr_release_tables_private,
      has_table_privilege('rembr_app', 'rembr_security_migration_state', 'SELECT')
        AND NOT has_table_privilege('rembr_app', 'rembr_security_migration_state', 'INSERT')
        AND NOT has_table_privilege('rembr_app', 'rembr_security_migration_state', 'UPDATE')
        AND NOT has_table_privilege('rembr_app', 'rembr_security_migration_state', 'DELETE')
        AS security_migration_marker_read_only,
      NOT COALESCE(has_table_privilege(
        'rembr_app', to_regclass('public._prisma_migrations'), 'SELECT'), false)
        AND NOT COALESCE(has_table_privilege(
          'rembr_app', to_regclass('public._prisma_migrations'), 'INSERT'), false)
        AND NOT COALESCE(has_table_privilege(
          'rembr_app', to_regclass('public._prisma_migrations'), 'UPDATE'), false)
        AND NOT COALESCE(has_table_privilege(
          'rembr_app', to_regclass('public._prisma_migrations'), 'DELETE'), false)
        AS prisma_migration_ledger_private,
      has_table_privilege('rembr_app', 'audit_logs', 'SELECT')
        AND has_table_privilege('rembr_app', 'audit_logs', 'INSERT')
        AND NOT has_table_privilege('rembr_app', 'audit_logs', 'UPDATE')
        AND NOT has_table_privilege('rembr_app', 'audit_logs', 'DELETE')
        AS audit_log_privileges_safe,
      NOT EXISTS (
        SELECT 1
        FROM pg_default_acl defaults
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
        WHERE defaults.defaclnamespace = 'public'::regnamespace
          AND defaults.defaclobjtype IN ('r', 'S')
          AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'rembr_app')
      ) AS future_application_objects_private,
      NOT EXISTS (
        SELECT 1
        FROM pg_class shared
        JOIN pg_namespace shared_namespace ON shared_namespace.oid = shared.relnamespace
        WHERE shared_namespace.nspname = 'public'
          AND shared.relrowsecurity
          AND shared.relname = ANY (ARRAY[
            'tenants', 'users', 'accounts', 'sessions', 'verification_tokens',
            'projects', 'project_members', 'api_keys', 'oauth_apps', 'oauth_tokens',
            'authorization_codes', 'memory_embeddings', 'contexts',
            'memory_contexts', 'context_summaries', 'context_snapshots',
            'snapshot_memories', 'snapshot_contexts', 'memory_relationships',
            'compiled_insights', 'memory_tags', 'tenant_plans', 'usage_daily',
            'stripe_events', 'invitations', 'email_sends',
            'agent_signup_rate_limits', 'feature_flags'
          ]::name[])
      ) AS shared_tables_do_not_depend_on_tenant_guc,
      NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
        WHERE n.nspname = 'public'
          AND p.proname IN ('search_memories_at_time', 'hybrid_search')
          AND acl.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname = 'rembr_app'))
          AND acl.privilege_type = 'EXECUTE'
      ) AS unsafe_search_functions_revoked
      ,EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = 'rembr_shadow'
          AND rolcanlogin = $1::boolean AND NOT rolsuper AND NOT rolcreatedb
          AND NOT rolcreaterole AND NOT rolinherit AND NOT rolbypassrls
      ) AS shadow_role_inert
      ,to_regclass('public.relationship_shadow_queue') IS NOT NULL
        AND to_regclass('public.relationship_shadow_predictions') IS NOT NULL
        AND to_regclass('public.relationship_shadow_allowlist') IS NOT NULL
        AND to_regclass('public.relationship_shadow_http_attempts') IS NOT NULL
        AND to_regclass('public.relationship_shadow_replay_cases') IS NOT NULL
        AS shadow_tables_present
      ,NOT has_table_privilege('rembr_shadow', 'public.memories', 'SELECT')
        AND NOT has_table_privilege('rembr_shadow', 'public.memory_relationships', 'SELECT')
        AND NOT has_table_privilege('rembr_shadow', 'public.memory_relationships', 'INSERT')
        AND NOT has_table_privilege('rembr_shadow', 'public.memory_relationships', 'UPDATE')
        AND NOT has_table_privilege('rembr_shadow', 'public.memory_relationships', 'DELETE')
        AS shadow_graph_boundary
      ,has_function_privilege(
          'rembr_shadow',
          'rembr_shadow_load_relationship_pair(uuid,uuid,uuid,text)',
          'EXECUTE'
        ) AS shadow_bounded_loader
      ,has_function_privilege(
          'rembr_shadow',
          'rembr_shadow_reserve_http_attempt(uuid,uuid,uuid,uuid,text,smallint,integer,numeric,timestamp with time zone)',
          'EXECUTE'
        ) AND NOT has_table_privilege(
          'rembr_shadow', 'public.relationship_shadow_http_attempts', 'SELECT'
        ) AS shadow_attempt_boundary
    FROM pg_class c
    JOIN pg_namespace boundary_namespace
      ON boundary_namespace.oid = c.relnamespace
    WHERE boundary_namespace.nspname = 'public'
      AND c.relname IN (
      'memories', 'causal_relationships', 'temporal_snapshots',
      'rlm_sessions', 'rlm_iterations'
    )
  `, [shadowRoleLoginEnabled])

  if (!Object.values(verification.rows[0]).every(Boolean)) {
    throw new Error('security boundary verification failed')
  }

  await client.query('COMMIT')
  if (applyAllMigrations) {
    console.log(`Applied ${prerequisiteMigrations.length} prerequisite MCP migrations atomically`)
  }
  console.log('Security migrations 030-032 applied and verified')
} catch (error) {
  try {
    await client.query('ROLLBACK')
  } catch {
    // The original failure remains authoritative.
  }
  const message = error instanceof Error ? error.message : 'unknown error'
  console.error(`Security migrations 030-032 failed: ${message}`)
  process.exitCode = 1
} finally {
  await client.end().catch(() => undefined)
}
