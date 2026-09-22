-- Optional live TypeSafe System One/Jev relationship decisions.
--
-- The existing local relationship engine always runs and writes first. Jev is
-- allowed to refine that result only after an accepted (>= 0.8) prediction.
-- Any admission failure, exhausted local budget, exhausted provider credit,
-- timeout, circuit-open response, invalid response, or low-confidence answer
-- therefore leaves the existing local result in place.

ALTER TABLE public.relationship_shadow_predictions
  ADD COLUMN IF NOT EXISTS application_action VARCHAR(32),
  ADD COLUMN IF NOT EXISTS decision_applied_at TIMESTAMPTZ;

ALTER TABLE public.relationship_shadow_predictions
  DROP CONSTRAINT IF EXISTS relationship_shadow_predictions_application_action_check;
ALTER TABLE public.relationship_shadow_predictions
  ADD CONSTRAINT relationship_shadow_predictions_application_action_check CHECK (
    application_action IS NULL OR application_action IN (
      'shadow_only', 'fallback_retained', 'inserted', 'updated', 'deleted_local'
    )
  );

-- Preserve the locked replay contract while permitting a deployment operator
-- to activate a bounded live run. This is an installation/deployment choice;
-- there is no customer-facing tenant feature flag.
ALTER TABLE public.relationship_shadow_allowlist
  DROP CONSTRAINT IF EXISTS relationship_shadow_allowlist_activation_contract;
ALTER TABLE public.relationship_shadow_allowlist
  ADD CONSTRAINT relationship_shadow_allowlist_activation_contract CHECK (
    NOT provider_enabled OR (
      capture_enabled
      AND active_run_id IS NOT NULL
      AND (
        (
          cohort = 'controlled'
          AND import_batch IS NOT NULL
          AND fixture_set_sha256 ~ '^[0-9a-f]{64}$'
          AND baseline_set_sha256 ~ '^[0-9a-f]{64}$'
          AND max_total_requests = 100
          AND max_total_input_tokens = 225000
          AND max_total_cost_usd = 0.02
        )
        OR
        (
          cohort = 'live'
          AND import_batch = 'live-preferred-fallback-v1'
          AND fixture_set_sha256 IS NULL
          AND baseline_set_sha256 IS NULL
        )
      )
    )
  );

-- Live captures are deliberately single-attempt. The local relationship has
-- already been written, so retrying externally adds cost without improving
-- fallback availability.
CREATE OR REPLACE FUNCTION public.rembr_capture_relationship_shadow_candidate(
  p_tenant_id UUID,
  p_project_id UUID,
  p_source_memory_id UUID,
  p_target_memory_id UUID,
  p_question_set TEXT,
  p_state_envelope TEXT,
  p_local_similarity DOUBLE PRECISION,
  p_local_relationship_type TEXT,
  p_local_confidence DOUBLE PRECISION,
  p_local_selected_for_write BOOLEAN,
  p_local_decision_reason TEXT,
  p_sampling_stratum TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $capture$
DECLARE
  v_limit INTEGER;
  v_id UUID;
BEGIN
  IF p_source_memory_id = p_target_memory_id
     OR length(p_question_set) NOT BETWEEN 1 AND 128
     OR length(p_state_envelope) NOT BETWEEN 1 AND 64
     OR p_local_similarity NOT BETWEEN 0 AND 1
     OR p_local_decision_reason NOT IN
       ('selected', 'below_similarity', 'below_confidence', 'not_top_eight')
     OR p_sampling_stratum NOT IN
       ('local_write', 'local_skip', 'near_similarity_threshold',
        'temporal_replacement', 'lexical_overlap', 'other') THEN
    RAISE EXCEPTION 'invalid relationship shadow candidate';
  END IF;

  SELECT allowlist.max_total_requests
    INTO v_limit
  FROM public.relationship_shadow_allowlist allowlist
  JOIN public.projects project
    ON project.id = allowlist.project_id
   AND project.tenant_id = allowlist.tenant_id
  WHERE allowlist.tenant_id = p_tenant_id
    AND allowlist.project_id = p_project_id
    AND allowlist.cohort = 'live'
    AND allowlist.capture_enabled
  FOR UPDATE OF allowlist;

  IF v_limit IS NULL THEN RETURN NULL; END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.memories source_memory
    JOIN public.memories target_memory
      ON target_memory.id = p_target_memory_id
     AND target_memory.tenant_id = p_tenant_id
     AND target_memory.project_id = p_project_id
    WHERE source_memory.id = p_source_memory_id
      AND source_memory.tenant_id = p_tenant_id
      AND source_memory.project_id = p_project_id
  ) THEN
    RAISE EXCEPTION 'relationship candidate is outside the live deployment scope';
  END IF;

  SELECT queue.id INTO v_id
  FROM public.relationship_shadow_queue queue
  WHERE queue.tenant_id = p_tenant_id
    AND queue.project_id = p_project_id
    AND queue.source_memory_id = p_source_memory_id
    AND queue.target_memory_id = p_target_memory_id
    AND queue.question_set = p_question_set
    AND queue.state_envelope = p_state_envelope;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  IF (SELECT count(*) FROM public.relationship_shadow_queue queue
      WHERE queue.tenant_id = p_tenant_id AND queue.project_id = p_project_id) >= v_limit THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.relationship_shadow_queue (
    tenant_id, project_id, source_memory_id, target_memory_id,
    question_set, state_envelope, local_similarity,
    local_relationship_type, local_confidence, local_selected_for_write,
    local_decision_reason, sampling_stratum, max_attempts, provenance_kind
  ) VALUES (
    p_tenant_id, p_project_id, p_source_memory_id, p_target_memory_id,
    p_question_set, p_state_envelope, p_local_similarity,
    p_local_relationship_type, p_local_confidence, p_local_selected_for_write,
    p_local_decision_reason, p_sampling_stratum, 1, 'live_candidate'
  )
  ON CONFLICT (
    tenant_id, project_id, source_memory_id, target_memory_id,
    question_set, state_envelope
  ) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT queue.id INTO v_id
    FROM public.relationship_shadow_queue queue
    WHERE queue.tenant_id = p_tenant_id
      AND queue.project_id = p_project_id
      AND queue.source_memory_id = p_source_memory_id
      AND queue.target_memory_id = p_target_memory_id
      AND queue.question_set = p_question_set
      AND queue.state_envelope = p_state_envelope;
  END IF;
  RETURN v_id;
END
$capture$;

-- Deployment activation is the consent boundary. Live content does not need a
-- second per-memory opt-in flag; database PII state plus the worker's local PII
-- and secret scan still fail closed before any provider request.
CREATE OR REPLACE FUNCTION public.rembr_shadow_load_relationship_pair(
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
   AND allowlist.cohort = 'live'
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
   AND allowlist.cohort = 'controlled'
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

-- Reserve against the activated run's bounded budget. The fixed 100-case
-- replay remains exact; live deployments use the explicit limits supplied by
-- their owner-only activation call.
CREATE OR REPLACE FUNCTION public.rembr_shadow_reserve_http_attempt(
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
  v_max_requests INTEGER;
  v_max_tokens BIGINT;
  v_max_cost NUMERIC;
  v_cohort TEXT;
BEGIN
  IF length(p_worker_id) NOT BETWEEN 1 AND 128 OR p_attempt_number <> 1
     OR p_reserved_input_tokens NOT BETWEEN 1 AND 225000
     OR p_reserved_cost_usd <= 0 OR p_requested_at > CURRENT_TIMESTAMP + interval '1 minute' THEN
    RAISE EXCEPTION 'invalid relationship attempt reservation';
  END IF;

  SELECT allowlist.max_total_requests, allowlist.max_total_input_tokens,
         allowlist.max_total_cost_usd, allowlist.cohort
    INTO v_max_requests, v_max_tokens, v_max_cost, v_cohort
  FROM public.relationship_shadow_allowlist allowlist
  WHERE allowlist.tenant_id = p_tenant_id AND allowlist.project_id = p_project_id
    AND allowlist.capture_enabled AND allowlist.provider_enabled
    AND allowlist.active_run_id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'relationship provider activation gate is closed'; END IF;
  IF v_cohort = 'controlled' AND
     (v_max_requests <> 100 OR v_max_tokens <> 225000 OR v_max_cost <> 0.02) THEN
    RAISE EXCEPTION 'locked replay budget differs';
  END IF;

  PERFORM 1 FROM public.relationship_shadow_queue queue
  WHERE queue.id = p_queue_id AND queue.tenant_id = p_tenant_id
    AND queue.project_id = p_project_id AND queue.status = 'leased'
    AND queue.lease_owner = p_worker_id AND queue.leased_until > CURRENT_TIMESTAMP
    AND queue.max_attempts = 1 AND queue.attempt_count = 1
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'relationship lease is invalid or not single-attempt'; END IF;

  SELECT count(*), COALESCE(sum(reserved_input_tokens), 0), COALESCE(sum(reserved_cost_usd), 0)
    INTO v_request_count, v_token_count, v_cost
  FROM public.relationship_shadow_http_attempts
  WHERE tenant_id = p_tenant_id AND project_id = p_project_id AND run_id = p_run_id;
  IF v_request_count + 1 > v_max_requests
     OR v_token_count + p_reserved_input_tokens > v_max_tokens
     OR v_cost + p_reserved_cost_usd > v_max_cost THEN
    RAISE EXCEPTION 'relationship provider hard attempt budget exhausted';
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

-- Keep the thoroughly validated, hash-pinned recorder from migration 032 as a
-- private primitive, then wrap it with the live apply/fallback transaction.
DO $rename_recorder$
BEGIN
  IF to_regprocedure('public.rembr_shadow_record_relationship_prediction(uuid,uuid,smallint,uuid,uuid,text,text,text,text,text,jsonb,double precision,boolean,text,text,integer,smallint,text,integer,integer,numeric,timestamp with time zone,timestamp with time zone,uuid,text)') IS NULL THEN
    ALTER FUNCTION public.rembr_shadow_complete_relationship_prediction(
      UUID, UUID, SMALLINT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
      JSONB, DOUBLE PRECISION, BOOLEAN, TEXT, TEXT, INTEGER, SMALLINT,
      TEXT, INTEGER, INTEGER, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT
    ) RENAME TO rembr_shadow_record_relationship_prediction;
  END IF;
END
$rename_recorder$;

REVOKE ALL ON FUNCTION public.rembr_shadow_record_relationship_prediction(
  UUID, UUID, SMALLINT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  JSONB, DOUBLE PRECISION, BOOLEAN, TEXT, TEXT, INTEGER, SMALLINT,
  TEXT, INTEGER, INTEGER, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT
) FROM PUBLIC, rembr_app, rembr_shadow;

CREATE OR REPLACE FUNCTION public.rembr_shadow_complete_relationship_prediction(
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
  v_relationship_id UUID;
  v_local_evidence TEXT;
  v_jev_evidence TEXT;
  v_action TEXT := 'fallback_retained';
BEGIN
  v_prediction_id := public.rembr_shadow_record_relationship_prediction(
    p_queue_id, p_run_id, p_repeat_index, p_tenant_id, p_project_id, p_worker_id,
    p_provider, p_requested_model, p_returned_model, p_predicted_relationship,
    p_probabilities, p_confidence, p_accepted_by_gate, p_raw_content_sha256,
    p_cleaned_content_sha256, p_duration_ms, p_request_attempts,
    p_http_result_class, p_input_tokens, p_output_tokens, p_estimated_cost_usd,
    p_requested_at, p_completed_at, p_attempt_id, p_prediction_sha256
  );

  SELECT * INTO STRICT v_queue
  FROM public.relationship_shadow_queue
  WHERE id = p_queue_id AND tenant_id = p_tenant_id AND project_id = p_project_id;

  IF v_queue.provenance_kind = 'curated_replay' THEN
    v_action := 'shadow_only';
  ELSIF p_accepted_by_gate THEN
    v_local_evidence := CASE v_queue.local_relationship_type
      WHEN 'supports' THEN 'Contains supporting information or confirms details'
      WHEN 'refines' THEN 'Provides additional detail or clarification'
      WHEN 'supersedes' THEN 'Contains updated or newer information'
      WHEN 'relates_to' THEN 'Shares similar topics or concepts'
      ELSE NULL
    END;
    IF v_local_evidence IS NOT NULL THEN
      v_local_evidence := v_local_evidence || '. Semantic similarity: ' ||
        round(v_queue.local_similarity * 100)::integer::text || '%';
    END IF;

    -- Match only a row carrying the local inference engine's exact evidence;
    -- manually authored or other subsystem relationships are never replaced.
    SELECT relationship.id INTO v_relationship_id
    FROM public.memory_relationships relationship
    WHERE ((relationship.source_memory_id = v_queue.source_memory_id
            AND relationship.target_memory_id = v_queue.target_memory_id)
        OR (relationship.source_memory_id = v_queue.target_memory_id
            AND relationship.target_memory_id = v_queue.source_memory_id))
      AND relationship.relationship_type = v_queue.local_relationship_type
      AND relationship.confidence IS NOT DISTINCT FROM v_queue.local_confidence
      AND relationship.evidence IS NOT DISTINCT FROM v_local_evidence
    ORDER BY relationship.created_at DESC, relationship.id
    LIMIT 1
    FOR UPDATE;

    IF p_predicted_relationship = 'unrelated' THEN
      IF v_relationship_id IS NOT NULL THEN
        DELETE FROM public.memory_relationships WHERE id = v_relationship_id;
        v_action := 'deleted_local';
      END IF;
    ELSE
      v_jev_evidence := format(
        'TypeSafe Jev 1.13.0 accepted %s -> %s at %s%% confidence; local fallback: %s at %s%%.',
        v_queue.target_memory_id, v_queue.source_memory_id,
        round(p_confidence * 100)::integer,
        COALESCE(v_queue.local_relationship_type, 'none'),
        COALESCE(round(v_queue.local_confidence * 100)::integer::text, 'n/a')
      );

      IF v_relationship_id IS NULL THEN
        SELECT relationship.id INTO v_relationship_id
        FROM public.memory_relationships relationship
        WHERE ((relationship.source_memory_id = v_queue.target_memory_id
                AND relationship.target_memory_id = v_queue.source_memory_id)
            OR (relationship.source_memory_id = v_queue.source_memory_id
                AND relationship.target_memory_id = v_queue.target_memory_id))
          AND relationship.relationship_type = p_predicted_relationship
          AND relationship.evidence LIKE 'TypeSafe Jev 1.13.0 accepted %'
        ORDER BY relationship.created_at DESC, relationship.id
        LIMIT 1
        FOR UPDATE;
      END IF;

      IF v_relationship_id IS NULL THEN
        INSERT INTO public.memory_relationships (
          id, source_memory_id, target_memory_id, relationship_type,
          confidence, evidence, created_at
        ) VALUES (
          gen_random_uuid(), v_queue.target_memory_id, v_queue.source_memory_id,
          p_predicted_relationship, p_confidence, v_jev_evidence, CURRENT_TIMESTAMP
        ) RETURNING id INTO v_relationship_id;
        v_action := 'inserted';
      ELSE
        UPDATE public.memory_relationships
        SET source_memory_id = v_queue.target_memory_id,
            target_memory_id = v_queue.source_memory_id,
            relationship_type = p_predicted_relationship,
            confidence = p_confidence,
            evidence = v_jev_evidence
        WHERE id = v_relationship_id;
        v_action := 'updated';
      END IF;
    END IF;
  END IF;

  UPDATE public.relationship_shadow_predictions
  SET application_action = v_action,
      decision_applied_at = CASE
        WHEN v_action IN ('inserted', 'updated', 'deleted_local') THEN CURRENT_TIMESTAMP
        ELSE NULL
      END
  WHERE id = v_prediction_id;
  RETURN v_prediction_id;
END
$complete$;

-- Owner-only bounded activation for a real project. Repeating the same run is
-- idempotent; a different active run must be stopped explicitly first.
CREATE OR REPLACE FUNCTION public.rembr_admin_activate_relationship_live(
  p_tenant_id UUID,
  p_project_id UUID,
  p_run_id UUID,
  p_max_total_requests INTEGER DEFAULT 250,
  p_max_total_input_tokens BIGINT DEFAULT 750000,
  p_max_total_cost_usd NUMERIC DEFAULT 0.05,
  p_max_requests_per_cycle INTEGER DEFAULT 5
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $activate$
BEGIN
  IF p_max_total_requests NOT BETWEEN 1 AND 5000
     OR p_max_total_input_tokens NOT BETWEEN 1 AND 3000000
     OR p_max_total_cost_usd <= 0 OR p_max_total_cost_usd > 5.00
     OR p_max_requests_per_cycle NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'invalid live relationship provider budget';
  END IF;
  PERFORM 1 FROM public.projects
  WHERE id = p_project_id AND tenant_id = p_tenant_id
    AND EXISTS (SELECT 1 FROM public.memories WHERE project_id = p_project_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'live relationship project scope is invalid'; END IF;

  INSERT INTO public.relationship_shadow_allowlist (
    tenant_id, project_id, cohort, capture_enabled, provider_enabled,
    max_total_requests, max_total_input_tokens, max_total_cost_usd,
    max_content_chars, active_run_id, import_batch, fixture_set_sha256,
    baseline_set_sha256, max_requests_per_cycle
  ) VALUES (
    p_tenant_id, p_project_id, 'live', TRUE, TRUE,
    p_max_total_requests, p_max_total_input_tokens, p_max_total_cost_usd,
    16000, p_run_id, 'live-preferred-fallback-v1', NULL, NULL,
    p_max_requests_per_cycle
  ) ON CONFLICT (tenant_id, project_id) DO UPDATE SET
    cohort = 'live', capture_enabled = TRUE, provider_enabled = TRUE,
    max_total_requests = EXCLUDED.max_total_requests,
    max_total_input_tokens = EXCLUDED.max_total_input_tokens,
    max_total_cost_usd = EXCLUDED.max_total_cost_usd,
    max_content_chars = 16000, active_run_id = EXCLUDED.active_run_id,
    import_batch = 'live-preferred-fallback-v1', fixture_set_sha256 = NULL,
    baseline_set_sha256 = NULL,
    max_requests_per_cycle = EXCLUDED.max_requests_per_cycle,
    updated_at = CURRENT_TIMESTAMP
  WHERE NOT relationship_shadow_allowlist.provider_enabled
     OR (relationship_shadow_allowlist.cohort = 'live'
       AND relationship_shadow_allowlist.active_run_id = EXCLUDED.active_run_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'a different relationship provider run is already enabled'; END IF;
  RETURN TRUE;
END
$activate$;

CREATE OR REPLACE FUNCTION public.rembr_admin_stop_relationship_live(
  p_tenant_id UUID, p_project_id UUID, p_run_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $stop$
BEGIN
  UPDATE public.relationship_shadow_allowlist
  SET provider_enabled = FALSE, capture_enabled = FALSE, updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = p_tenant_id AND project_id = p_project_id
    AND cohort = 'live' AND active_run_id = p_run_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'live relationship provider scope or run differs'; END IF;
  UPDATE public.relationship_shadow_queue
  SET status = 'cancelled', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
      leased_until = NULL, lease_owner = NULL, last_error_class = 'operator_stop'
  WHERE tenant_id = p_tenant_id AND project_id = p_project_id
    AND provenance_kind = 'live_candidate' AND status IN ('pending', 'failed', 'leased');
  UPDATE public.relationship_shadow_http_attempts
  SET status = 'abandoned', completed_at = CURRENT_TIMESTAMP
  WHERE tenant_id = p_tenant_id AND project_id = p_project_id
    AND run_id = p_run_id AND status = 'reserved';
  RETURN TRUE;
END
$stop$;

REVOKE ALL ON FUNCTION public.rembr_shadow_complete_relationship_prediction(
  UUID, UUID, SMALLINT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  JSONB, DOUBLE PRECISION, BOOLEAN, TEXT, TEXT, INTEGER, SMALLINT,
  TEXT, INTEGER, INTEGER, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rembr_shadow_complete_relationship_prediction(
  UUID, UUID, SMALLINT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  JSONB, DOUBLE PRECISION, BOOLEAN, TEXT, TEXT, INTEGER, SMALLINT,
  TEXT, INTEGER, INTEGER, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT
) TO rembr_shadow;

REVOKE ALL ON FUNCTION public.rembr_admin_activate_relationship_live(
  UUID, UUID, UUID, INTEGER, BIGINT, NUMERIC, INTEGER
) FROM PUBLIC, rembr_app, rembr_shadow;
REVOKE ALL ON FUNCTION public.rembr_admin_stop_relationship_live(UUID, UUID, UUID)
  FROM PUBLIC, rembr_app, rembr_shadow;
