-- Token-free audit state for the two-transaction SFU admission protocol.
SET LOCAL search_path = hello_friend, pg_catalog;

CREATE TABLE sfu_admission_audit (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  session_id uuid NOT NULL REFERENCES participant_sessions (id) ON DELETE RESTRICT,
  participant_id uuid NOT NULL REFERENCES participants (id) ON DELETE RESTRICT,
  meeting_id uuid NOT NULL REFERENCES meetings (id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  token_id uuid NOT NULL UNIQUE,
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 128),
  permission_profile_version smallint NOT NULL CHECK (permission_profile_version > 0),
  state text NOT NULL
    CHECK (state IN ('requested', 'issued', 'sign_failed', 'invalidated')),
  result_code text CHECK (result_code IS NULL OR length(result_code) BETWEEN 1 AND 64),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  issued_at timestamptz,
  expires_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  UNIQUE (session_id, command_id),
  CHECK (expires_at > requested_at),
  CHECK (state <> 'issued' OR issued_at IS NOT NULL),
  CHECK (state <> 'invalidated' OR invalidated_at IS NOT NULL)
);

CREATE INDEX sfu_admission_audit_session_idx
  ON sfu_admission_audit (session_id, requested_at DESC);
CREATE INDEX sfu_admission_audit_maintenance_idx
  ON sfu_admission_audit (state, expires_at, requested_at)
  WHERE state IN ('requested', 'issued');

REVOKE ALL ON TABLE sfu_admission_audit FROM PUBLIC;
