-- Locked 100-case System One/Jev shadow activation boundary.
--
-- This migration remains inert until an owner imports the sanitised replay
-- manifest and calls the owner-only activation function. rembr_shadow receives
-- only bounded SECURITY DEFINER functions and never direct table access.

ALTER TABLE relationship_shadow_allowlist
  ADD COLUMN IF NOT EXISTS active_run_id UUID,
  ADD COLUMN IF NOT EXISTS import_batch VARCHAR(160),
  ADD COLUMN IF NOT EXISTS fixture_set_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS baseline_set_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS max_requests_per_cycle INTEGER NOT NULL DEFAULT 1
    CHECK (max_requests_per_cycle BETWEEN 1 AND 10);

ALTER TABLE relationship_shadow_allowlist
  DROP CONSTRAINT IF EXISTS relationship_shadow_allowlist_activation_contract;
ALTER TABLE relationship_shadow_allowlist
  ADD CONSTRAINT relationship_shadow_allowlist_activation_contract CHECK (
    NOT provider_enabled OR (
      capture_enabled
      AND active_run_id IS NOT NULL
      AND (
        (cohort = 'controlled'
          AND import_batch IS NOT NULL
          AND fixture_set_sha256 ~ '^[0-9a-f]{64}$'
          AND baseline_set_sha256 ~ '^[0-9a-f]{64}$'
          AND max_total_requests = 100
          AND max_total_input_tokens = 225000
          AND max_total_cost_usd = 0.02)
        OR
        (cohort = 'live'
          AND import_batch = 'live-preferred-fallback-v1'
          AND fixture_set_sha256 IS NULL
          AND baseline_set_sha256 IS NULL)
      )
    )
  );

CREATE TABLE IF NOT EXISTS relationship_shadow_replay_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  case_id VARCHAR(96) NOT NULL,
  import_batch VARCHAR(160) NOT NULL,
  source_content TEXT NOT NULL,
  target_content TEXT NOT NULL,
  expected_relationship VARCHAR(32) NOT NULL CHECK (expected_relationship IN
    ('supports', 'refines', 'supersedes', 'relates_to', 'unrelated')),
  baseline_relationship VARCHAR(32) NOT NULL CHECK (baseline_relationship IN
    ('supports', 'refines', 'supersedes', 'relates_to', 'unrelated')),
  conditional_constraints JSONB NOT NULL,
  fixture_sha256 CHAR(64) NOT NULL CHECK (fixture_sha256 ~ '^[0-9a-f]{64}$'),
  baseline_sha256 CHAR(64) NOT NULL CHECK (baseline_sha256 ~ '^[0-9a-f]{64}$'),
  fixture_set_sha256 CHAR(64) NOT NULL CHECK (fixture_set_sha256 ~ '^[0-9a-f]{64}$'),
  baseline_set_sha256 CHAR(64) NOT NULL CHECK (baseline_set_sha256 ~ '^[0-9a-f]{64}$'),
  data_classification VARCHAR(16) NOT NULL CHECK (data_classification = 'sanitised'),
  split VARCHAR(16) NOT NULL CHECK (split = 'locked'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, project_id, case_id),
  CHECK (length(case_id) BETWEEN 1 AND 96),
  CHECK (length(import_batch) BETWEEN 1 AND 160),
  CHECK (length(source_content) BETWEEN 1 AND 16000),
  CHECK (length(target_content) BETWEEN 1 AND 16000),
  CHECK (pg_column_size(conditional_constraints) <= 8192)
);

ALTER TABLE relationship_shadow_replay_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_shadow_replay_cases FORCE ROW LEVEL SECURITY;

ALTER TABLE relationship_shadow_queue
  ALTER COLUMN source_memory_id DROP NOT NULL,
  ALTER COLUMN target_memory_id DROP NOT NULL,
  ALTER COLUMN local_similarity DROP NOT NULL,
  ALTER COLUMN local_selected_for_write DROP NOT NULL,
  ALTER COLUMN local_decision_reason DROP NOT NULL,
  ALTER COLUMN sampling_stratum DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS provenance_kind VARCHAR(24) NOT NULL DEFAULT 'live_candidate',
  ADD COLUMN IF NOT EXISTS replay_case_id UUID REFERENCES relationship_shadow_replay_cases(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS case_id VARCHAR(96),
  ADD COLUMN IF NOT EXISTS import_batch VARCHAR(160),
  ADD COLUMN IF NOT EXISTS expected_relationship VARCHAR(32),
  ADD COLUMN IF NOT EXISTS fixture_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS baseline_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS conditional_constraints JSONB;

ALTER TABLE relationship_shadow_queue
  DROP CONSTRAINT IF EXISTS relationship_shadow_queue_provenance_contract;
ALTER TABLE relationship_shadow_queue
  ADD CONSTRAINT relationship_shadow_queue_provenance_contract CHECK (
    (provenance_kind = 'live_candidate'
      AND source_memory_id IS NOT NULL AND target_memory_id IS NOT NULL
      AND replay_case_id IS NULL AND case_id IS NULL AND import_batch IS NULL
      AND expected_relationship IS NULL AND fixture_sha256 IS NULL
      AND baseline_sha256 IS NULL AND conditional_constraints IS NULL
      AND local_similarity IS NOT NULL AND local_selected_for_write IS NOT NULL
      AND local_decision_reason IS NOT NULL AND sampling_stratum IS NOT NULL)
    OR
    (provenance_kind = 'curated_replay'
      AND source_memory_id IS NULL AND target_memory_id IS NULL
      AND replay_case_id IS NOT NULL AND case_id IS NOT NULL AND import_batch IS NOT NULL
      AND expected_relationship IN ('supports', 'refines', 'supersedes', 'relates_to', 'unrelated')
      AND fixture_sha256 ~ '^[0-9a-f]{64}$'
      AND baseline_sha256 ~ '^[0-9a-f]{64}$'
      AND conditional_constraints IS NOT NULL
      AND local_similarity IS NULL AND local_relationship_type IS NULL
      AND local_confidence IS NULL AND local_selected_for_write IS NULL
      AND local_decision_reason IS NULL AND sampling_stratum IS NULL
      AND max_attempts = 1)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_relationship_shadow_queue_replay_case
  ON relationship_shadow_queue (tenant_id, project_id, case_id)
  WHERE provenance_kind = 'curated_replay';

CREATE TABLE IF NOT EXISTS relationship_shadow_http_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id UUID NOT NULL REFERENCES relationship_shadow_queue(id) ON DELETE CASCADE,
  run_id UUID NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worker_id VARCHAR(128) NOT NULL,
  attempt_number SMALLINT NOT NULL CHECK (attempt_number = 1),
  reserved_input_tokens INTEGER NOT NULL CHECK (reserved_input_tokens BETWEEN 1 AND 225000),
  reserved_cost_usd NUMERIC(12, 8) NOT NULL CHECK (reserved_cost_usd > 0),
  status VARCHAR(24) NOT NULL DEFAULT 'reserved' CHECK (status IN
    ('reserved', 'succeeded', 'timeout', 'rate_limited', 'upstream_error',
     'invalid_response', 'network_error', 'abandoned')),
  requested_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  actual_cost_usd NUMERIC(12, 8) CHECK (actual_cost_usd IS NULL OR actual_cost_usd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (queue_id, run_id, attempt_number),
  CHECK ((status = 'reserved' AND completed_at IS NULL) OR
         (status <> 'reserved' AND completed_at IS NOT NULL)),
  CHECK (completed_at IS NULL OR completed_at >= requested_at)
);

CREATE INDEX IF NOT EXISTS idx_relationship_shadow_attempt_budget
  ON relationship_shadow_http_attempts (tenant_id, project_id, run_id);
ALTER TABLE relationship_shadow_http_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_shadow_http_attempts FORCE ROW LEVEL SECURITY;

ALTER TABLE relationship_shadow_predictions
  ADD COLUMN IF NOT EXISTS attempt_id UUID REFERENCES relationship_shadow_http_attempts(id),
  ADD COLUMN IF NOT EXISTS case_id VARCHAR(96),
  ADD COLUMN IF NOT EXISTS import_batch VARCHAR(160),
  ADD COLUMN IF NOT EXISTS fixture_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS baseline_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS prediction_sha256 CHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_relationship_shadow_prediction_attempt
  ON relationship_shadow_predictions (attempt_id) WHERE attempt_id IS NOT NULL;

-- Replace the loader so overlength content is rejected, never truncated, and
-- sanitised replay text is served with its exact locked provenance.
CREATE OR REPLACE FUNCTION rembr_shadow_load_relationship_pair(
  p_queue_id UUID,
  p_tenant_id UUID,
  p_project_id UUID,
  p_worker_id TEXT
) RETURNS TABLE (
  source_content TEXT,
  target_content TEXT,
  source_metadata JSONB,
  target_metadata JSONB
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $load$
  SELECT source_memory.content, target_memory.content,
         source_memory.metadata, target_memory.metadata
  FROM public.relationship_shadow_queue queue
  JOIN public.relationship_shadow_allowlist allowlist
    ON allowlist.tenant_id = queue.tenant_id AND allowlist.project_id = queue.project_id
   AND allowlist.capture_enabled AND allowlist.provider_enabled
  JOIN public.memories source_memory
    ON source_memory.id = queue.source_memory_id
   AND source_memory.tenant_id = queue.tenant_id AND source_memory.project_id = queue.project_id
  JOIN public.memories target_memory
    ON target_memory.id = queue.target_memory_id
   AND target_memory.tenant_id = queue.tenant_id AND target_memory.project_id = queue.project_id
  WHERE queue.id = p_queue_id AND queue.tenant_id = p_tenant_id
    AND queue.project_id = p_project_id AND queue.provenance_kind = 'live_candidate'
    AND queue.status = 'leased' AND queue.lease_owner = p_worker_id
    AND queue.leased_until > CURRENT_TIMESTAMP
    AND char_length(source_memory.content) <= allowlist.max_content_chars
    AND char_length(target_memory.content) <= allowlist.max_content_chars
    AND lower(COALESCE(source_memory.metadata->>'external_processing_allowed', 'false')) = 'true'
    AND lower(COALESCE(target_memory.metadata->>'external_processing_allowed', 'false')) = 'true'
    AND source_memory.pii_detected IS NOT TRUE AND target_memory.pii_detected IS NOT TRUE
  UNION ALL
  SELECT replay.source_content, replay.target_content,
         jsonb_build_object(
           'data_classification', replay.data_classification, 'split', replay.split,
           'case_id', replay.case_id, 'fixture_sha256', replay.fixture_sha256,
           'baseline_sha256', replay.baseline_sha256, 'import_batch', replay.import_batch,
           'conditional_constraints', replay.conditional_constraints),
         jsonb_build_object(
           'data_classification', replay.data_classification, 'split', replay.split,
           'case_id', replay.case_id, 'expected_relationship', replay.expected_relationship)
  FROM public.relationship_shadow_queue queue
  JOIN public.relationship_shadow_allowlist allowlist
    ON allowlist.tenant_id = queue.tenant_id AND allowlist.project_id = queue.project_id
   AND allowlist.capture_enabled AND allowlist.provider_enabled
   AND allowlist.import_batch = queue.import_batch
  JOIN public.relationship_shadow_replay_cases replay
    ON replay.id = queue.replay_case_id AND replay.tenant_id = queue.tenant_id
   AND replay.project_id = queue.project_id AND replay.case_id = queue.case_id
   AND replay.fixture_sha256 = queue.fixture_sha256
   AND replay.baseline_sha256 = queue.baseline_sha256
  WHERE queue.id = p_queue_id AND queue.tenant_id = p_tenant_id
    AND queue.project_id = p_project_id AND queue.provenance_kind = 'curated_replay'
    AND queue.status = 'leased' AND queue.lease_owner = p_worker_id
    AND queue.leased_until > CURRENT_TIMESTAMP
    AND char_length(replay.source_content) <= allowlist.max_content_chars
    AND char_length(replay.target_content) <= allowlist.max_content_chars
$load$;

DROP FUNCTION IF EXISTS rembr_shadow_get_relationship_budget(UUID, UUID);
CREATE FUNCTION rembr_shadow_get_relationship_budget(
  p_tenant_id UUID,
  p_project_id UUID
) RETURNS TABLE (
  provider_enabled BOOLEAN,
  remaining_requests BIGINT,
  remaining_input_tokens BIGINT,
  remaining_cost_usd NUMERIC,
  max_requests_per_cycle INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $budget$
  SELECT allowlist.capture_enabled AND allowlist.provider_enabled,
    GREATEST(allowlist.max_total_requests - count(attempt.id), 0),
    GREATEST(allowlist.max_total_input_tokens - COALESCE(sum(attempt.reserved_input_tokens), 0), 0),
    GREATEST(allowlist.max_total_cost_usd - COALESCE(sum(attempt.reserved_cost_usd), 0), 0),
    allowlist.max_requests_per_cycle
  FROM public.relationship_shadow_allowlist allowlist
  LEFT JOIN public.relationship_shadow_http_attempts attempt
    ON attempt.tenant_id = allowlist.tenant_id AND attempt.project_id = allowlist.project_id
   AND attempt.run_id = allowlist.active_run_id
  WHERE allowlist.tenant_id = p_tenant_id AND allowlist.project_id = p_project_id
  GROUP BY allowlist.capture_enabled, allowlist.provider_enabled,
    allowlist.max_total_requests, allowlist.max_total_input_tokens,
    allowlist.max_total_cost_usd, allowlist.max_requests_per_cycle
$budget$;

CREATE OR REPLACE FUNCTION rembr_shadow_reserve_http_attempt(
  p_queue_id UUID, p_run_id UUID, p_tenant_id UUID, p_project_id UUID,
  p_worker_id TEXT, p_attempt_number SMALLINT, p_reserved_input_tokens INTEGER,
  p_reserved_cost_usd NUMERIC, p_requested_at TIMESTAMPTZ
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $reserve$
DECLARE
  v_attempt_id UUID;
  v_request_count BIGINT;
  v_token_count BIGINT;
  v_cost NUMERIC;
BEGIN
  IF length(p_worker_id) NOT BETWEEN 1 AND 128 OR p_attempt_number <> 1
     OR p_reserved_input_tokens NOT BETWEEN 1 AND 225000
     OR p_reserved_cost_usd <= 0 OR p_requested_at > CURRENT_TIMESTAMP + interval '1 minute' THEN
    RAISE EXCEPTION 'invalid relationship shadow attempt reservation';
  END IF;
  PERFORM 1 FROM public.relationship_shadow_allowlist allowlist
  WHERE allowlist.tenant_id = p_tenant_id AND allowlist.project_id = p_project_id
    AND allowlist.capture_enabled AND allowlist.provider_enabled
    AND allowlist.active_run_id = p_run_id
    AND allowlist.max_total_requests = 100
    AND allowlist.max_total_input_tokens = 225000
    AND allowlist.max_total_cost_usd = 0.02
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'relationship shadow activation gate is closed'; END IF;

  PERFORM 1 FROM public.relationship_shadow_queue queue
  WHERE queue.id = p_queue_id AND queue.tenant_id = p_tenant_id
    AND queue.project_id = p_project_id AND queue.status = 'leased'
    AND queue.lease_owner = p_worker_id AND queue.leased_until > CURRENT_TIMESTAMP
    AND queue.max_attempts = 1 AND queue.attempt_count = 1
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'relationship shadow lease is invalid or not single-attempt'; END IF;

  SELECT count(*), COALESCE(sum(reserved_input_tokens), 0), COALESCE(sum(reserved_cost_usd), 0)
    INTO v_request_count, v_token_count, v_cost
  FROM public.relationship_shadow_http_attempts
  WHERE tenant_id = p_tenant_id AND project_id = p_project_id AND run_id = p_run_id;
  IF v_request_count + 1 > 100 OR v_token_count + p_reserved_input_tokens > 225000
     OR v_cost + p_reserved_cost_usd > 0.02 THEN
    RAISE EXCEPTION 'relationship shadow hard attempt budget exhausted';
  END IF;
  INSERT INTO public.relationship_shadow_http_attempts (
    queue_id, run_id, tenant_id, project_id, worker_id, attempt_number,
    reserved_input_tokens, reserved_cost_usd, requested_at
  ) VALUES (
    p_queue_id, p_run_id, p_tenant_id, p_project_id, p_worker_id, p_attempt_number,
    p_reserved_input_tokens, p_reserved_cost_usd, p_requested_at
  ) RETURNING id INTO v_attempt_id;
  RETURN v_attempt_id;
END
$reserve$;

CREATE OR REPLACE FUNCTION rembr_shadow_finish_http_attempt(
  p_attempt_id UUID, p_tenant_id UUID, p_project_id UUID, p_outcome TEXT,
  p_completed_at TIMESTAMPTZ, p_http_status INTEGER, p_input_tokens INTEGER,
  p_output_tokens INTEGER, p_actual_cost_usd NUMERIC
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $finish$
DECLARE v_updated INTEGER;
BEGIN
  IF p_outcome NOT IN ('succeeded', 'timeout', 'rate_limited', 'upstream_error',
      'invalid_response', 'network_error', 'abandoned')
     OR p_completed_at > CURRENT_TIMESTAMP + interval '1 minute'
     OR (p_http_status IS NOT NULL AND p_http_status NOT BETWEEN 100 AND 599)
     OR (p_input_tokens IS NOT NULL AND p_input_tokens < 0)
     OR (p_output_tokens IS NOT NULL AND p_output_tokens < 0)
     OR (p_actual_cost_usd IS NOT NULL AND p_actual_cost_usd < 0) THEN
    RAISE EXCEPTION 'invalid relationship shadow attempt completion';
  END IF;
  UPDATE public.relationship_shadow_http_attempts
  SET status = p_outcome, completed_at = p_completed_at, http_status = p_http_status,
      input_tokens = p_input_tokens, output_tokens = p_output_tokens,
      actual_cost_usd = p_actual_cost_usd
  WHERE id = p_attempt_id AND tenant_id = p_tenant_id AND project_id = p_project_id
    AND status = 'reserved' AND p_completed_at >= requested_at;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END
$finish$;

DROP FUNCTION IF EXISTS rembr_shadow_complete_relationship_prediction(
  UUID, UUID, SMALLINT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  JSONB, DOUBLE PRECISION, BOOLEAN, TEXT, TEXT, INTEGER, SMALLINT,
  TEXT, INTEGER, INTEGER, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ
);
CREATE OR REPLACE FUNCTION rembr_shadow_complete_relationship_prediction(
  p_queue_id UUID, p_run_id UUID, p_repeat_index SMALLINT,
  p_tenant_id UUID, p_project_id UUID, p_worker_id TEXT,
  p_provider TEXT, p_requested_model TEXT, p_returned_model TEXT,
  p_predicted_relationship TEXT, p_probabilities JSONB,
  p_confidence DOUBLE PRECISION, p_accepted_by_gate BOOLEAN,
  p_raw_content_sha256 TEXT, p_cleaned_content_sha256 TEXT,
  p_duration_ms INTEGER, p_request_attempts SMALLINT, p_http_result_class TEXT,
  p_input_tokens INTEGER, p_output_tokens INTEGER, p_estimated_cost_usd NUMERIC,
  p_requested_at TIMESTAMPTZ, p_completed_at TIMESTAMPTZ,
  p_attempt_id UUID, p_prediction_sha256 TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $complete$
DECLARE
  v_prediction_id UUID;
  v_queue public.relationship_shadow_queue%ROWTYPE;
  v_attempt public.relationship_shadow_http_attempts%ROWTYPE;
  v_probability_sum DOUBLE PRECISION;
  v_selected_probability DOUBLE PRECISION;
  v_highest_probability DOUBLE PRECISION;
BEGIN
  IF p_repeat_index <> 0 OR p_provider <> 'typesafe-system-one'
     OR p_requested_model <> 'jev-1.13.0' OR p_returned_model <> 'jev-1.13.0'
     OR p_predicted_relationship NOT IN ('supports', 'refines', 'supersedes', 'relates_to', 'unrelated')
     OR p_confidence::text IN ('NaN', 'Infinity', '-Infinity') OR p_confidence NOT BETWEEN 0 AND 1
     OR p_accepted_by_gate IS DISTINCT FROM (p_confidence >= 0.8)
     OR p_raw_content_sha256 !~ '^[0-9a-f]{64}$'
     OR p_cleaned_content_sha256 !~ '^[0-9a-f]{64}$'
     OR p_prediction_sha256 !~ '^[0-9a-f]{64}$'
     OR p_duration_ms < 0 OR p_request_attempts <> 1 OR p_http_result_class <> '2xx'
     OR p_input_tokens < 0 OR p_output_tokens < 0
     OR p_estimated_cost_usd <> round((p_input_tokens::numeric / 1000000) * 0.042, 8)
     OR p_completed_at < p_requested_at OR pg_column_size(p_probabilities) > 8192 THEN
    RAISE EXCEPTION 'invalid or unpinned relationship shadow prediction';
  END IF;
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_each(p_probabilities)) <>
     ARRAY['refines','relates_to','supersedes','supports','unrelated']::text[] THEN
    RAISE EXCEPTION 'relationship shadow probability labels are not pinned';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each_text(p_probabilities)
             WHERE value !~ '^-?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
                OR value::double precision::text IN ('NaN','Infinity','-Infinity')
                OR value::double precision NOT BETWEEN 0 AND 1) THEN
    RAISE EXCEPTION 'invalid relationship shadow probability value';
  END IF;
  SELECT sum(value::double precision), max(value::double precision)
    INTO v_probability_sum, v_highest_probability FROM jsonb_each_text(p_probabilities);
  v_selected_probability := (p_probabilities ->> p_predicted_relationship)::double precision;
  IF abs(v_probability_sum - 1) > 0.02 OR v_selected_probability <> v_highest_probability THEN
    RAISE EXCEPTION 'inconsistent relationship shadow choice distribution';
  END IF;

  SELECT * INTO v_queue FROM public.relationship_shadow_queue queue
  WHERE queue.id = p_queue_id AND queue.tenant_id = p_tenant_id
    AND queue.project_id = p_project_id AND queue.status = 'leased'
    AND queue.lease_owner = p_worker_id AND queue.leased_until > CURRENT_TIMESTAMP
    AND queue.question_set = 'rembr-system-one-j2-2026-09-17'
    AND queue.state_envelope = 'strip-shared-sentences-v1'
    AND queue.max_attempts = 1 AND queue.attempt_count = 1
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'relationship shadow lease or pinned rubric is invalid'; END IF;

  SELECT * INTO v_attempt FROM public.relationship_shadow_http_attempts attempt
  WHERE attempt.id = p_attempt_id AND attempt.queue_id = p_queue_id
    AND attempt.run_id = p_run_id AND attempt.tenant_id = p_tenant_id
    AND attempt.project_id = p_project_id AND attempt.worker_id = p_worker_id
    AND attempt.attempt_number = 1 AND attempt.status = 'succeeded'
    AND attempt.http_status BETWEEN 200 AND 299
    AND attempt.requested_at = p_requested_at
    AND p_completed_at >= attempt.completed_at
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'relationship shadow HTTP attempt is not a completed pinned success'; END IF;
  IF v_attempt.input_tokens IS DISTINCT FROM p_input_tokens
     OR v_attempt.output_tokens IS DISTINCT FROM p_output_tokens
     OR v_attempt.actual_cost_usd IS DISTINCT FROM p_estimated_cost_usd THEN
    RAISE EXCEPTION 'relationship shadow usage differs from the HTTP attempt record';
  END IF;

  INSERT INTO public.relationship_shadow_predictions (
    queue_id, run_id, repeat_index, tenant_id, project_id, provider,
    requested_model, returned_model, question_set, state_envelope,
    predicted_relationship, probabilities, confidence, accepted_by_gate,
    raw_content_sha256, cleaned_content_sha256, pii_scan_passed, secret_scan_passed,
    duration_ms, request_attempts, http_result_class, input_tokens, output_tokens,
    estimated_cost_usd, requested_at, completed_at, attempt_id, case_id,
    import_batch, fixture_sha256, baseline_sha256, prediction_sha256
  ) VALUES (
    p_queue_id, p_run_id, 0, p_tenant_id, p_project_id, p_provider,
    p_requested_model, p_returned_model, v_queue.question_set, v_queue.state_envelope,
    p_predicted_relationship, p_probabilities, p_confidence, p_accepted_by_gate,
    p_raw_content_sha256, p_cleaned_content_sha256, TRUE, TRUE,
    p_duration_ms, 1, p_http_result_class, p_input_tokens, p_output_tokens,
    p_estimated_cost_usd, p_requested_at, p_completed_at, p_attempt_id,
    v_queue.case_id, v_queue.import_batch, v_queue.fixture_sha256,
    v_queue.baseline_sha256, p_prediction_sha256
  ) RETURNING id INTO v_prediction_id;
  UPDATE public.relationship_shadow_queue SET status = 'succeeded',
    completed_at = CURRENT_TIMESTAMP, leased_until = NULL, lease_owner = NULL,
    last_error_class = NULL WHERE id = p_queue_id;
  RETURN v_prediction_id;
END
$complete$;

CREATE OR REPLACE FUNCTION rembr_shadow_fail_relationship_candidate(
  p_queue_id UUID, p_tenant_id UUID, p_project_id UUID, p_worker_id TEXT,
  p_terminal BOOLEAN, p_error_class TEXT, p_retry_delay_seconds INTEGER DEFAULT 30
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fail$
DECLARE v_updated INTEGER;
BEGIN
  IF length(p_error_class) NOT BETWEEN 1 AND 80
     OR p_retry_delay_seconds NOT BETWEEN 0 AND 3600 THEN
    RAISE EXCEPTION 'invalid relationship shadow failure record';
  END IF;
  UPDATE public.relationship_shadow_queue queue
  SET status = CASE WHEN p_terminal OR queue.attempt_count >= queue.max_attempts
                    THEN 'skipped' ELSE 'failed' END,
      available_at = CURRENT_TIMESTAMP + make_interval(secs => p_retry_delay_seconds),
      completed_at = CASE WHEN p_terminal OR queue.attempt_count >= queue.max_attempts
                          THEN CURRENT_TIMESTAMP ELSE NULL END,
      leased_until = NULL, lease_owner = NULL, last_error_class = p_error_class
  WHERE queue.id = p_queue_id AND queue.tenant_id = p_tenant_id
    AND queue.project_id = p_project_id AND queue.status = 'leased'
    AND queue.lease_owner = p_worker_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END
$fail$;

-- Owner-only, idempotent and hash-locked import primitive. The migration is
-- product-generic: deployment-specific identity and naming are supplied by
-- the reviewed operator client rather than embedded in every installation.
DROP FUNCTION IF EXISTS rembr_admin_bootstrap_relationship_replay_project();
CREATE OR REPLACE FUNCTION rembr_admin_bootstrap_relationship_replay_project(
  p_tenant_id UUID, p_owner_user_id UUID, p_project_name TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $bootstrap$
DECLARE
  v_project public.projects%ROWTYPE;
  v_member public.project_members%ROWTYPE;
  v_project_count INTEGER;
BEGIN
  IF p_tenant_id IS NULL OR p_owner_user_id IS NULL
     OR length(btrim(p_project_name)) NOT BETWEEN 1 AND 160
     OR p_project_name IS DISTINCT FROM btrim(p_project_name) THEN
    RAISE EXCEPTION 'invalid replay project scope';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_project_name, 0
  ));
  PERFORM 1 FROM public.tenants WHERE id = p_tenant_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'replay tenant is absent or inactive'; END IF;
  PERFORM 1 FROM public.users
  WHERE id = p_owner_user_id AND tenant_id = p_tenant_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'replay owner is absent, inactive, or outside tenant'; END IF;

  SELECT count(*) INTO v_project_count FROM public.projects
  WHERE tenant_id = p_tenant_id AND name = p_project_name;
  IF v_project_count > 1 THEN
    RAISE EXCEPTION 'replay project name is not unique within tenant';
  ELSIF v_project_count = 0 THEN
    INSERT INTO public.projects (
      id, tenant_id, name, description, created_by, is_personal, owner_id
    ) VALUES (
      gen_random_uuid(), p_tenant_id, p_project_name,
      'Locked sanitised System One relationship replay; no customer memory content.',
      p_owner_user_id, FALSE, NULL
    ) RETURNING * INTO v_project;
  ELSE
    SELECT * INTO STRICT v_project FROM public.projects
    WHERE tenant_id = p_tenant_id AND name = p_project_name FOR UPDATE;
  END IF;
  IF v_project.is_personal OR v_project.created_by IS DISTINCT FROM p_owner_user_id
        OR v_project.owner_id IS NOT NULL THEN
    RAISE EXCEPTION 'replay project exists with incompatible ownership or visibility';
  END IF;

  SELECT * INTO v_member FROM public.project_members
  WHERE project_id = v_project.id AND user_id = p_owner_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.project_members (id, project_id, user_id, role, added_by)
    VALUES (gen_random_uuid(), v_project.id, p_owner_user_id, 'owner', p_owner_user_id);
  ELSIF v_member.role <> 'owner' OR v_member.added_by <> p_owner_user_id THEN
    RAISE EXCEPTION 'replay membership differs from the owner contract';
  END IF;
  IF EXISTS (SELECT 1 FROM public.project_members
             WHERE project_id = v_project.id AND user_id <> p_owner_user_id) THEN
    RAISE EXCEPTION 'replay project has an unexpected member';
  END IF;
  IF EXISTS (SELECT 1 FROM public.memories WHERE project_id = v_project.id) THEN
    RAISE EXCEPTION 'replay project is not empty';
  END IF;
  RETURN v_project.id;
END
$bootstrap$;

CREATE OR REPLACE FUNCTION rembr_admin_import_relationship_replay_case(
  p_tenant_id UUID, p_project_id UUID, p_case_id TEXT, p_import_batch TEXT,
  p_source_content TEXT, p_target_content TEXT, p_expected_relationship TEXT,
  p_baseline_relationship TEXT, p_conditional_constraints JSONB,
  p_fixture_sha256 TEXT, p_baseline_sha256 TEXT,
  p_fixture_set_sha256 TEXT, p_baseline_set_sha256 TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $import$
DECLARE v_case public.relationship_shadow_replay_cases%ROWTYPE; v_queue_id UUID;
BEGIN
  IF p_case_id !~ '^boundary-relationship-[0-9]{3}-[0-3]$'
     OR length(p_import_batch) NOT BETWEEN 1 AND 160
     OR p_expected_relationship NOT IN ('supports','refines','supersedes','relates_to','unrelated')
     OR p_baseline_relationship NOT IN ('supports','refines','supersedes','relates_to','unrelated')
     OR p_fixture_sha256 !~ '^[0-9a-f]{64}$' OR p_baseline_sha256 !~ '^[0-9a-f]{64}$'
     OR p_fixture_set_sha256 !~ '^[0-9a-f]{64}$' OR p_baseline_set_sha256 !~ '^[0-9a-f]{64}$'
     OR length(p_source_content) NOT BETWEEN 1 AND 16000
     OR length(p_target_content) NOT BETWEEN 1 AND 16000
     OR pg_column_size(p_conditional_constraints) > 8192 THEN
    RAISE EXCEPTION 'invalid locked replay case';
  END IF;
  PERFORM 1 FROM public.projects
  WHERE id = p_project_id AND tenant_id = p_tenant_id AND NOT is_personal
    AND NOT EXISTS (SELECT 1 FROM public.memories WHERE project_id = p_project_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'replay case scope is invalid'; END IF;
  SELECT * INTO v_case FROM public.relationship_shadow_replay_cases
  WHERE tenant_id = p_tenant_id AND project_id = p_project_id AND case_id = p_case_id
  FOR UPDATE;
  IF FOUND AND (v_case.import_batch IS DISTINCT FROM p_import_batch
     OR v_case.source_content IS DISTINCT FROM p_source_content
     OR v_case.target_content IS DISTINCT FROM p_target_content
     OR v_case.expected_relationship IS DISTINCT FROM p_expected_relationship
     OR v_case.baseline_relationship IS DISTINCT FROM p_baseline_relationship
     OR v_case.conditional_constraints IS DISTINCT FROM p_conditional_constraints
     OR v_case.fixture_sha256 IS DISTINCT FROM p_fixture_sha256
     OR v_case.baseline_sha256 IS DISTINCT FROM p_baseline_sha256
     OR v_case.fixture_set_sha256 IS DISTINCT FROM p_fixture_set_sha256
     OR v_case.baseline_set_sha256 IS DISTINCT FROM p_baseline_set_sha256) THEN
    RAISE EXCEPTION 'replay case hash lock differs for %', p_case_id;
  END IF;
  IF NOT FOUND THEN
    INSERT INTO public.relationship_shadow_replay_cases (
      tenant_id, project_id, case_id, import_batch, source_content, target_content,
      expected_relationship, baseline_relationship, conditional_constraints,
      fixture_sha256, baseline_sha256, fixture_set_sha256, baseline_set_sha256,
      data_classification, split
    ) VALUES (
      p_tenant_id, p_project_id, p_case_id, p_import_batch, p_source_content, p_target_content,
      p_expected_relationship, p_baseline_relationship, p_conditional_constraints,
      p_fixture_sha256, p_baseline_sha256, p_fixture_set_sha256, p_baseline_set_sha256,
      'sanitised', 'locked'
    ) RETURNING * INTO v_case;
  END IF;
  INSERT INTO public.relationship_shadow_queue (
    tenant_id, project_id, source_memory_id, target_memory_id, question_set,
    state_envelope, max_attempts, local_similarity, local_relationship_type,
    local_confidence, local_selected_for_write, local_decision_reason,
    sampling_stratum, provenance_kind, replay_case_id, case_id, import_batch,
    expected_relationship, fixture_sha256, baseline_sha256, conditional_constraints
  ) VALUES (
    p_tenant_id, p_project_id, NULL, NULL, 'rembr-system-one-j2-2026-09-17',
    'strip-shared-sentences-v1', 1, NULL, NULL, NULL, NULL, NULL, NULL,
    'curated_replay', v_case.id, p_case_id, p_import_batch,
    p_expected_relationship, p_fixture_sha256, p_baseline_sha256, p_conditional_constraints
  ) ON CONFLICT (tenant_id, project_id, case_id)
    WHERE provenance_kind = 'curated_replay' DO NOTHING
  RETURNING id INTO v_queue_id;
  IF v_queue_id IS NULL THEN
    SELECT id INTO v_queue_id FROM public.relationship_shadow_queue
    WHERE tenant_id = p_tenant_id AND project_id = p_project_id
      AND case_id = p_case_id AND provenance_kind = 'curated_replay'
      AND replay_case_id = v_case.id
      AND question_set = 'rembr-system-one-j2-2026-09-17'
      AND state_envelope = 'strip-shared-sentences-v1'
      AND max_attempts = 1
      AND source_memory_id IS NULL AND target_memory_id IS NULL
      AND local_similarity IS NULL AND local_relationship_type IS NULL
      AND local_confidence IS NULL AND local_selected_for_write IS NULL
      AND local_decision_reason IS NULL AND sampling_stratum IS NULL
      AND import_batch = p_import_batch
      AND expected_relationship = p_expected_relationship
      AND fixture_sha256 = p_fixture_sha256
      AND baseline_sha256 = p_baseline_sha256
      AND conditional_constraints IS NOT DISTINCT FROM p_conditional_constraints;
  END IF;
  IF v_queue_id IS NULL THEN RAISE EXCEPTION 'replay queue hash lock differs for %', p_case_id; END IF;
  RETURN v_queue_id;
END
$import$;

CREATE OR REPLACE FUNCTION rembr_admin_activate_relationship_replay(
  p_tenant_id UUID, p_project_id UUID, p_run_id UUID, p_import_batch TEXT,
  p_fixture_set_sha256 TEXT, p_baseline_set_sha256 TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $activate$
DECLARE v_count INTEGER;
BEGIN
  PERFORM 1 FROM public.projects
  WHERE id = p_project_id AND tenant_id = p_tenant_id AND NOT is_personal
    AND NOT EXISTS (SELECT 1 FROM public.memories WHERE project_id = p_project_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'activation scope is invalid'; END IF;
  SELECT count(*) INTO v_count FROM public.relationship_shadow_replay_cases replay
  JOIN public.relationship_shadow_queue queue ON queue.replay_case_id = replay.id
  WHERE replay.tenant_id = p_tenant_id AND replay.project_id = p_project_id
    AND replay.import_batch = p_import_batch
    AND replay.fixture_set_sha256 = p_fixture_set_sha256
    AND replay.baseline_set_sha256 = p_baseline_set_sha256
    AND queue.max_attempts = 1 AND queue.provenance_kind = 'curated_replay'
    AND queue.question_set = 'rembr-system-one-j2-2026-09-17'
    AND queue.state_envelope = 'strip-shared-sentences-v1'
    AND queue.source_memory_id IS NULL AND queue.target_memory_id IS NULL
    AND queue.local_similarity IS NULL AND queue.local_relationship_type IS NULL
    AND queue.local_confidence IS NULL AND queue.local_selected_for_write IS NULL
    AND queue.local_decision_reason IS NULL AND queue.sampling_stratum IS NULL
    AND queue.case_id = replay.case_id
    AND queue.import_batch = replay.import_batch
    AND queue.expected_relationship = replay.expected_relationship
    AND queue.fixture_sha256 = replay.fixture_sha256
    AND queue.baseline_sha256 = replay.baseline_sha256
    AND queue.conditional_constraints IS NOT DISTINCT FROM replay.conditional_constraints;
  IF v_count <> 100 THEN RAISE EXCEPTION 'activation requires exactly 100 hash-locked replay cases'; END IF;
  INSERT INTO public.relationship_shadow_allowlist (
    tenant_id, project_id, cohort, capture_enabled, provider_enabled,
    max_total_requests, max_total_input_tokens, max_total_cost_usd,
    max_content_chars, active_run_id, import_batch, fixture_set_sha256,
    baseline_set_sha256, max_requests_per_cycle
  ) VALUES (
    p_tenant_id, p_project_id, 'controlled', TRUE, TRUE,
    100, 225000, 0.02, 16000, p_run_id, p_import_batch,
    p_fixture_set_sha256, p_baseline_set_sha256, 1
  ) ON CONFLICT (tenant_id, project_id) DO UPDATE SET
    cohort = 'controlled', capture_enabled = TRUE, provider_enabled = TRUE,
    max_total_requests = 100, max_total_input_tokens = 225000,
    max_total_cost_usd = 0.02, max_content_chars = 16000,
    active_run_id = EXCLUDED.active_run_id, import_batch = EXCLUDED.import_batch,
    fixture_set_sha256 = EXCLUDED.fixture_set_sha256,
    baseline_set_sha256 = EXCLUDED.baseline_set_sha256,
    max_requests_per_cycle = CASE
      WHEN relationship_shadow_allowlist.active_run_id = EXCLUDED.active_run_id
        THEN relationship_shadow_allowlist.max_requests_per_cycle
      ELSE 1
    END,
    updated_at = CURRENT_TIMESTAMP
  WHERE NOT relationship_shadow_allowlist.provider_enabled
     OR (relationship_shadow_allowlist.active_run_id = EXCLUDED.active_run_id
       AND relationship_shadow_allowlist.import_batch = EXCLUDED.import_batch
       AND relationship_shadow_allowlist.fixture_set_sha256 = EXCLUDED.fixture_set_sha256
       AND relationship_shadow_allowlist.baseline_set_sha256 = EXCLUDED.baseline_set_sha256);
  IF NOT FOUND THEN RAISE EXCEPTION 'a different shadow activation is already enabled'; END IF;
  RETURN TRUE;
END
$activate$;

CREATE OR REPLACE FUNCTION rembr_admin_ramp_relationship_replay(
  p_tenant_id UUID, p_project_id UUID, p_run_id UUID, p_requests_per_cycle INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $ramp$
DECLARE v_current INTEGER; v_successes INTEGER; v_failures INTEGER;
BEGIN
  IF p_requests_per_cycle NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'replay ramp must be between one and ten requests per cycle';
  END IF;
  SELECT max_requests_per_cycle INTO v_current
  FROM public.relationship_shadow_allowlist
  WHERE tenant_id = p_tenant_id AND project_id = p_project_id
    AND active_run_id = p_run_id AND capture_enabled AND provider_enabled
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shadow activation is not enabled for this run'; END IF;
  IF v_current = p_requests_per_cycle THEN RETURN TRUE; END IF;
  SELECT count(*) FILTER (WHERE status = 'succeeded'),
         count(*) FILTER (WHERE status <> 'succeeded')
    INTO v_successes, v_failures
  FROM public.relationship_shadow_http_attempts
  WHERE tenant_id = p_tenant_id AND project_id = p_project_id AND run_id = p_run_id;
  IF p_requests_per_cycle > 1 AND (v_successes NOT BETWEEN 1 AND 3 OR v_failures <> 0) THEN
    RAISE EXCEPTION 'ramp requires one to three clean completed attempts';
  END IF;
  UPDATE public.relationship_shadow_allowlist
  SET max_requests_per_cycle = p_requests_per_cycle, updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = p_tenant_id AND project_id = p_project_id AND active_run_id = p_run_id;
  RETURN TRUE;
END
$ramp$;

CREATE OR REPLACE FUNCTION rembr_admin_stop_relationship_replay(
  p_tenant_id UUID, p_project_id UUID, p_run_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $stop$
DECLARE v_batch TEXT;
BEGIN
  SELECT import_batch INTO v_batch FROM public.relationship_shadow_allowlist
  WHERE tenant_id = p_tenant_id AND project_id = p_project_id
    AND (active_run_id IS NULL OR active_run_id = p_run_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shadow activation scope or run differs'; END IF;
  UPDATE public.relationship_shadow_allowlist SET provider_enabled = FALSE,
    capture_enabled = FALSE, updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = p_tenant_id AND project_id = p_project_id;
  UPDATE public.relationship_shadow_queue SET status = 'cancelled',
    completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP), leased_until = NULL,
    lease_owner = NULL, last_error_class = 'emergency_stop'
  WHERE tenant_id = p_tenant_id AND project_id = p_project_id
    AND import_batch = v_batch AND status IN ('pending','failed','leased');
  UPDATE public.relationship_shadow_http_attempts SET status = 'abandoned',
    completed_at = CURRENT_TIMESTAMP
  WHERE tenant_id = p_tenant_id AND project_id = p_project_id AND run_id = p_run_id
    AND status = 'reserved';
  EXECUTE 'ALTER ROLE rembr_shadow NOLOGIN';
  RETURN TRUE;
END
$stop$;

REVOKE ALL ON TABLE relationship_shadow_replay_cases,
  relationship_shadow_http_attempts FROM PUBLIC, rembr_app, rembr_shadow;
REVOKE ALL ON FUNCTION rembr_shadow_reserve_http_attempt(
  UUID, UUID, UUID, UUID, TEXT, SMALLINT, INTEGER, NUMERIC, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION rembr_shadow_finish_http_attempt(
  UUID, UUID, UUID, TEXT, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION rembr_shadow_complete_relationship_prediction(
  UUID, UUID, SMALLINT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  JSONB, DOUBLE PRECISION, BOOLEAN, TEXT, TEXT, INTEGER, SMALLINT,
  TEXT, INTEGER, INTEGER, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION rembr_admin_import_relationship_replay_case(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB,
  TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, rembr_app, rembr_shadow;
REVOKE ALL ON FUNCTION rembr_admin_bootstrap_relationship_replay_project(UUID, UUID, TEXT)
  FROM PUBLIC, rembr_app, rembr_shadow;
REVOKE ALL ON FUNCTION rembr_admin_activate_relationship_replay(
  UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, rembr_app, rembr_shadow;
REVOKE ALL ON FUNCTION rembr_admin_stop_relationship_replay(
  UUID, UUID, UUID) FROM PUBLIC, rembr_app, rembr_shadow;
REVOKE ALL ON FUNCTION rembr_admin_ramp_relationship_replay(
  UUID, UUID, UUID, INTEGER) FROM PUBLIC, rembr_app, rembr_shadow;

GRANT EXECUTE ON FUNCTION rembr_shadow_reserve_http_attempt(
  UUID, UUID, UUID, UUID, TEXT, SMALLINT, INTEGER, NUMERIC, TIMESTAMPTZ) TO rembr_shadow;
GRANT EXECUTE ON FUNCTION rembr_shadow_finish_http_attempt(
  UUID, UUID, UUID, TEXT, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER, NUMERIC) TO rembr_shadow;
GRANT EXECUTE ON FUNCTION rembr_shadow_complete_relationship_prediction(
  UUID, UUID, SMALLINT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  JSONB, DOUBLE PRECISION, BOOLEAN, TEXT, TEXT, INTEGER, SMALLINT,
  TEXT, INTEGER, INTEGER, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT) TO rembr_shadow;
