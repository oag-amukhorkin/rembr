#!/usr/bin/env node
// Bootstrap a self-hosted Rembr tenant + API key.
//
// Zero dependencies: generates an `mb_live_*` API key, prints the matching
// INSERT statements as SQL on stdout, and the key itself on stderr. Pipe the
// SQL into psql (directly or via docker compose):
//
//   node rembr-mcp/scripts/bootstrap-tenant.mjs \
//     | docker compose exec -T postgres psql -U rembr -d rembr
//
// The key is shown once and stored only as a hash. API_KEY_SECRET enables the
// engine's preferred HMAC-SHA256 format; otherwise the legacy SHA-256 format
// is used for compatibility.

import crypto from "node:crypto"

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

function randomAlphanumeric(length) {
  let out = ""
  const unbiasedLimit = 256 - (256 % ALPHANUMERIC.length)
  while (out.length < length) {
    const bytes = crypto.randomBytes(length - out.length)
    for (const byte of bytes) {
      if (byte < unbiasedLimit) out += ALPHANUMERIC[byte % ALPHANUMERIC.length]
    }
  }
  return out
}

const tenantName = process.env.TENANT_NAME || "self-hosted"
const tenantEmail = process.env.TENANT_EMAIL || "selfhost@localhost"
const keyName = process.env.KEY_NAME || "bootstrap"
const tenantPlan = (process.env.TENANT_PLAN || "free").toLowerCase()
const requireNoActiveKeys = ['true', '1', 'yes', 'on'].includes(
  String(process.env.REQUIRE_NO_ACTIVE_KEYS || '').toLowerCase(),
)

const planLimits = {
  free: { memory: 1000, search: 100, project: 5 },
  pro: { memory: 25000, search: 250000, project: 25 },
  team: { memory: 250000, search: 2500000, project: 999 },
  business: { memory: 1000000, search: 10000000, project: 999 },
  enterprise: { memory: 999999999, search: 999999999, project: 999 },
}

if (!Object.hasOwn(planLimits, tenantPlan)) {
  throw new Error(`TENANT_PLAN must be one of: ${Object.keys(planLimits).join(", ")}`)
}

const apiKey = `mb_live_${randomAlphanumeric(32)}`
const apiKeySecret = process.env.API_KEY_SECRET
const hashAlgorithm = apiKeySecret ? "hmac-sha256" : "sha256"
const keyHash = apiKeySecret
  ? crypto.createHmac("sha256", apiKeySecret).update(apiKey).digest("hex")
  : crypto.createHash("sha256").update(apiKey).digest("hex")
const keyPrefix = apiKey.slice(0, 20)
const limits = planLimits[tenantPlan]

const esc = (value) => value.replace(/'/g, "''")

process.stdout.write(`-- rembr self-host bootstrap (generated ${new Date().toISOString()})
WITH tenant AS (
  INSERT INTO tenants (name, email, plan)
  VALUES ('${esc(tenantName)}', '${esc(tenantEmail)}', '${tenantPlan}')
  ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, plan = EXCLUDED.plan
  RETURNING id
), tenant_locked AS (
  SELECT id, pg_advisory_xact_lock(hashtextextended('${esc(tenantEmail)}', 0))
  FROM tenant
), key_created AS (
  INSERT INTO api_keys (tenant_id, key_hash, key_prefix, hash_algorithm, name)
  SELECT id, '${keyHash}', '${keyPrefix}', '${hashAlgorithm}', '${esc(keyName)}'
  FROM tenant_locked
  WHERE ${requireNoActiveKeys ? "NOT EXISTS (SELECT 1 FROM api_keys WHERE tenant_id = tenant_locked.id AND revoked_at IS NULL)" : "TRUE"}
  RETURNING tenant_id
), plan_upsert AS (
  INSERT INTO tenant_plans (tenant_id, plan, memory_limit, search_limit_daily, project_limit)
  SELECT tenant_id, '${tenantPlan}', ${limits.memory}, ${limits.search}, ${limits.project}
  FROM key_created
  ON CONFLICT (tenant_id) DO UPDATE SET
    plan = EXCLUDED.plan,
    memory_limit = EXCLUDED.memory_limit,
    search_limit_daily = EXCLUDED.search_limit_daily,
    project_limit = EXCLUDED.project_limit,
    updated_at = CURRENT_TIMESTAMP
  RETURNING tenant_id
)
SELECT 1 / COUNT(*) AS key_created FROM plan_upsert;
`)

process.stderr.write(`
Rembr API key (shown once — store it now):

  ${apiKey}

Use it as REMBR_API_KEY for agent plugins and MCP clients (x-api-key header).
Tenant: "${tenantName}" <${tenantEmail}>. Plan: ${tenantPlan}.
`)
