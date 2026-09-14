-- Durable control-plane schema. PostgreSQL 18 is required for native uuidv7().
CREATE SCHEMA hello_friend AUTHORIZATION CURRENT_USER;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA hello_friend FROM PUBLIC;
SET LOCAL search_path = hello_friend, pg_catalog;

CREATE TABLE meetings (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mode text NOT NULL CHECK (mode IN ('video_conference', 'audio_call', 'live')),
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'active', 'ending', 'ended', 'expired')),
  chat_policy jsonb NOT NULL,
  policy_schema_version smallint NOT NULL DEFAULT 1 CHECK (policy_schema_version > 0),
  media_e2ee_policy text NOT NULL
    CHECK (media_e2ee_policy IN ('required', 'optional', 'disabled')),
  chat_e2ee_policy text NOT NULL DEFAULT 'required'
    CHECK (chat_e2ee_policy IN ('required')),
  history_policy text NOT NULL
    CHECK (history_policy IN ('strict_membership', 'shared_history')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz,
  ends_at timestamptz,
  ended_at timestamptz,
  expires_at timestamptz NOT NULL,
  CHECK (jsonb_typeof(chat_policy) = 'object'),
  CHECK (expires_at > created_at),
  CHECK (activated_at IS NULL OR activated_at >= created_at),
  CHECK (ended_at IS NULL OR ended_at >= created_at)
);

CREATE INDEX meetings_active_expiration_idx
  ON meetings (state, expires_at)
  WHERE state IN ('open', 'active', 'ending');
CREATE INDEX meetings_created_at_idx ON meetings (created_at);

CREATE TABLE meeting_capabilities (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  meeting_id uuid NOT NULL REFERENCES meetings (id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('host', 'invite', 'human_join_code')),
  secret_digest bytea NOT NULL CHECK (octet_length(secret_digest) = 32),
  pepper_version smallint NOT NULL CHECK (pepper_version > 0),
  grant_profile text NOT NULL CHECK (length(grant_profile) BETWEEN 1 AND 64),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  max_uses bigint CHECK (max_uses IS NULL OR max_uses > 0),
  use_count bigint NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  UNIQUE (kind, secret_digest, pepper_version),
  CHECK (max_uses IS NULL OR use_count <= max_uses),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at)
);

CREATE INDEX meeting_capabilities_meeting_idx ON meeting_capabilities (meeting_id, kind);
CREATE INDEX meeting_capabilities_expiration_idx
  ON meeting_capabilities (expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE participants (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  meeting_id uuid NOT NULL REFERENCES meetings (id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 128),
  product_role text NOT NULL CHECK (product_role IN ('host', 'participant', 'presenter', 'viewer')),
  sfu_role text NOT NULL CHECK (sfu_role IN ('host', 'speaker', 'viewer')),
  permission_profile text NOT NULL CHECK (length(permission_profile) BETWEEN 1 AND 64),
  permission_profile_version smallint NOT NULL CHECK (permission_profile_version > 0),
  state text NOT NULL CHECK (state IN ('pending_key_sync', 'active', 'left', 'revoked')),
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  left_at timestamptz,
  revoked_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, meeting_id),
  CHECK (left_at IS NULL OR left_at >= joined_at),
  CHECK (revoked_at IS NULL OR revoked_at >= joined_at),
  CHECK ((product_role = 'host') = (sfu_role = 'host')),
  CHECK ((product_role = 'viewer') = (sfu_role = 'viewer'))
);

CREATE INDEX participants_meeting_state_idx ON participants (meeting_id, state);
CREATE INDEX participants_meeting_joined_idx ON participants (meeting_id, joined_at, id);

CREATE TABLE participant_sessions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  participant_id uuid NOT NULL REFERENCES participants (id) ON DELETE RESTRICT,
  token_digest bytea NOT NULL CHECK (octet_length(token_digest) = 32),
  pepper_version smallint NOT NULL CHECK (pepper_version > 0),
  device_binding_digest bytea NOT NULL CHECK (octet_length(device_binding_digest) = 32),
  csrf_token_digest bytea NOT NULL CHECK (octet_length(csrf_token_digest) = 32),
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'rotating', 'revoked', 'expired')),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  rotated_from_session_id uuid REFERENCES participant_sessions (id) ON DELETE RESTRICT,
  UNIQUE (token_digest, pepper_version),
  CHECK (idle_expires_at > issued_at),
  CHECK (absolute_expires_at >= idle_expires_at),
  CHECK (last_seen_at >= issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CHECK (rotated_from_session_id IS NULL OR rotated_from_session_id <> id)
);

CREATE INDEX participant_sessions_participant_state_idx
  ON participant_sessions (participant_id, state);
CREATE INDEX participant_sessions_expiration_idx
  ON participant_sessions (LEAST(idle_expires_at, absolute_expires_at))
  WHERE state IN ('active', 'rotating');

CREATE TABLE realtime_ticket_audit (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  session_id uuid NOT NULL REFERENCES participant_sessions (id) ON DELETE RESTRICT,
  ticket_id uuid NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  result_code text,
  CHECK (expires_at > issued_at),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
  CHECK (result_code IS NULL OR length(result_code) BETWEEN 1 AND 64)
);

CREATE INDEX realtime_ticket_audit_session_idx ON realtime_ticket_audit (session_id, issued_at DESC);

CREATE TABLE meeting_stream_heads (
  meeting_id uuid PRIMARY KEY REFERENCES meetings (id) ON DELETE RESTRICT,
  last_position bigint NOT NULL DEFAULT 0 CHECK (last_position >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE e2ee_devices (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  participant_id uuid NOT NULL REFERENCES participants (id) ON DELETE RESTRICT,
  public_device_id uuid NOT NULL,
  signature_public_key bytea NOT NULL CHECK (octet_length(signature_public_key) BETWEEN 32 AND 8192),
  credential bytea NOT NULL CHECK (octet_length(credential) BETWEEN 64 AND 16384),
  signer_key_id text NOT NULL CHECK (length(signer_key_id) BETWEEN 1 AND 128),
  cipher_suites smallint[] NOT NULL CHECK (cardinality(cipher_suites) BETWEEN 1 AND 16),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (participant_id, public_device_id),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX e2ee_devices_participant_state_idx ON e2ee_devices (participant_id, state);

CREATE TABLE e2ee_key_packages (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  device_id uuid NOT NULL REFERENCES e2ee_devices (id) ON DELETE RESTRICT,
  package_reference bytea NOT NULL CHECK (octet_length(package_reference) BETWEEN 16 AND 128),
  package_hash bytea NOT NULL CHECK (octet_length(package_hash) = 32),
  key_package bytea NOT NULL CHECK (octet_length(key_package) BETWEEN 64 AND 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_group_id uuid,
  UNIQUE (package_hash),
  CHECK (expires_at > created_at),
  CHECK ((consumed_at IS NULL) = (consumed_by_group_id IS NULL))
);

CREATE INDEX e2ee_key_packages_available_idx
  ON e2ee_key_packages (device_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE e2ee_groups (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  meeting_id uuid NOT NULL REFERENCES meetings (id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('chat', 'media')),
  protocol_version smallint NOT NULL CHECK (protocol_version > 0),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  transcript_hash bytea NOT NULL CHECK (octet_length(transcript_hash) BETWEEN 32 AND 128),
  public_state_hash bytea NOT NULL CHECK (octet_length(public_state_hash) = 32),
  committer_device_id uuid REFERENCES e2ee_devices (id) ON DELETE RESTRICT,
  committer_lease_until timestamptz,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retired')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, meeting_id)
);

CREATE UNIQUE INDEX e2ee_groups_active_purpose_idx
  ON e2ee_groups (meeting_id, purpose)
  WHERE state = 'active';

ALTER TABLE e2ee_key_packages
  ADD CONSTRAINT e2ee_key_packages_consumed_group_fk
  FOREIGN KEY (consumed_by_group_id) REFERENCES e2ee_groups (id) ON DELETE RESTRICT;

CREATE TABLE e2ee_group_members (
  group_id uuid NOT NULL REFERENCES e2ee_groups (id) ON DELETE RESTRICT,
  device_id uuid NOT NULL REFERENCES e2ee_devices (id) ON DELETE RESTRICT,
  participant_id uuid NOT NULL REFERENCES participants (id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('pending', 'active', 'removed')),
  added_epoch bigint NOT NULL CHECK (added_epoch >= 0),
  removed_epoch bigint CHECK (removed_epoch IS NULL OR removed_epoch >= added_epoch),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (group_id, device_id)
);

CREATE INDEX e2ee_group_members_participant_idx
  ON e2ee_group_members (participant_id, state);

CREATE TABLE e2ee_artifacts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  group_id uuid NOT NULL REFERENCES e2ee_groups (id) ON DELETE RESTRICT,
  position bigint NOT NULL CHECK (position > 0),
  artifact_type text NOT NULL CHECK (artifact_type IN ('proposal', 'commit', 'welcome', 'ratchet_tree')),
  protocol_version smallint NOT NULL CHECK (protocol_version > 0),
  epoch bigint NOT NULL CHECK (epoch >= 0),
  sender_device_id uuid NOT NULL REFERENCES e2ee_devices (id) ON DELETE RESTRICT,
  recipient_device_id uuid REFERENCES e2ee_devices (id) ON DELETE RESTRICT,
  artifact bytea NOT NULL CHECK (octet_length(artifact) BETWEEN 1 AND 1048576),
  artifact_hash bytea NOT NULL CHECK (octet_length(artifact_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (group_id, position),
  UNIQUE (group_id, artifact_hash),
  CHECK ((artifact_type = 'welcome') = (recipient_device_id IS NOT NULL))
);

CREATE INDEX e2ee_artifacts_group_epoch_idx ON e2ee_artifacts (group_id, epoch, position);

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  meeting_id uuid NOT NULL REFERENCES meetings (id) ON DELETE RESTRICT,
  sender_participant_id uuid NOT NULL,
  position bigint NOT NULL CHECK (position > 0),
  client_message_id uuid NOT NULL,
  protocol_version smallint NOT NULL CHECK (protocol_version > 0),
  group_id uuid NOT NULL,
  e2ee_epoch bigint NOT NULL CHECK (e2ee_epoch >= 0),
  content_type text NOT NULL CHECK (content_type IN ('text', 'system', 'reaction', 'receipt')),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 131072),
  ciphertext_hash bytea NOT NULL CHECK (octet_length(ciphertext_hash) = 32),
  sender_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (sender_participant_id, meeting_id)
    REFERENCES participants (id, meeting_id) ON DELETE RESTRICT,
  FOREIGN KEY (group_id, meeting_id)
    REFERENCES e2ee_groups (id, meeting_id) ON DELETE RESTRICT,
  UNIQUE (meeting_id, position),
  UNIQUE (meeting_id, sender_participant_id, client_message_id),
  CHECK (jsonb_typeof(sender_metadata) = 'object'),
  CHECK (octet_length(sender_metadata::text) <= 4096),
  CHECK (expires_at > created_at)
);

CREATE INDEX chat_messages_history_idx
  ON chat_messages (meeting_id, position DESC)
  INCLUDE (id, sender_participant_id, created_at, content_type, e2ee_epoch);
CREATE INDEX chat_messages_expiration_idx ON chat_messages (expires_at);

CREATE TABLE outbox_events (
  delivery_id uuid PRIMARY KEY DEFAULT uuidv7(),
  event_id uuid NOT NULL,
  aggregate_type text NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 64),
  aggregate_id uuid NOT NULL,
  meeting_id uuid REFERENCES meetings (id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
  event_version smallint NOT NULL CHECK (event_version > 0),
  destination text NOT NULL CHECK (destination IN ('redis_realtime', 'kafka_backend', 'sfu_control')),
  partition_key text NOT NULL CHECK (length(partition_key) BETWEEN 1 AND 128),
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_by text,
  locked_until timestamptz,
  published_at timestamptz,
  dead_at timestamptz,
  last_error_code text,
  UNIQUE (event_id, destination),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (octet_length(payload::text) <= 262144),
  CHECK ((locked_by IS NULL) = (locked_until IS NULL)),
  CHECK (published_at IS NULL OR dead_at IS NULL),
  CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 64)
);

CREATE INDEX outbox_events_pending_idx
  ON outbox_events (available_at, created_at)
  WHERE published_at IS NULL AND dead_at IS NULL;
CREATE INDEX outbox_events_locked_idx
  ON outbox_events (locked_until)
  WHERE locked_until IS NOT NULL AND published_at IS NULL AND dead_at IS NULL;
CREATE INDEX outbox_events_meeting_idx ON outbox_events (meeting_id, created_at);

CREATE TABLE command_results (
  command_scope text NOT NULL CHECK (length(command_scope) BETWEEN 1 AND 64),
  command_id uuid NOT NULL,
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  status text NOT NULL CHECK (status IN ('in_progress', 'succeeded', 'failed')),
  resource_id uuid,
  response_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (command_scope, command_id),
  CHECK (jsonb_typeof(response_metadata) = 'object'),
  CHECK (octet_length(response_metadata::text) <= 16384),
  CHECK (expires_at > created_at)
);

CREATE INDEX command_results_expiration_idx ON command_results (expires_at);

CREATE TABLE inbox_events (
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
  event_version smallint NOT NULL CHECK (event_version > 0),
  source_partition integer,
  source_offset bigint,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (source, event_id),
  CHECK (jsonb_typeof(result) = 'object'),
  CHECK (octet_length(result::text) <= 16384),
  CHECK (processed_at IS NULL OR processed_at >= received_at)
);

CREATE INDEX inbox_events_unprocessed_idx
  ON inbox_events (received_at)
  WHERE processed_at IS NULL;

CREATE TABLE sfu_room_projections (
  meeting_id uuid PRIMARY KEY REFERENCES meetings (id) ON DELETE RESTRICT,
  sfu_room_id text NOT NULL CHECK (length(sfu_room_id) BETWEEN 1 AND 128),
  node_id text CHECK (node_id IS NULL OR length(node_id) BETWEEN 1 AND 128),
  region text CHECK (region IS NULL OR length(region) BETWEEN 1 AND 64),
  placement_epoch bigint NOT NULL DEFAULT 0 CHECK (placement_epoch >= 0),
  observed_state text NOT NULL CHECK (observed_state IN ('unknown', 'open', 'active', 'closing', 'closed')),
  producer_count integer NOT NULL DEFAULT 0 CHECK (producer_count >= 0),
  consumer_count integer NOT NULL DEFAULT 0 CHECK (consumer_count >= 0),
  last_event_id uuid,
  last_source_offset bigint,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sfu_room_id)
);

CREATE TABLE security_audit_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  meeting_id uuid REFERENCES meetings (id) ON DELETE RESTRICT,
  actor_participant_id uuid REFERENCES participants (id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
  target_type text CHECK (target_type IS NULL OR length(target_type) BETWEEN 1 AND 64),
  target_id uuid,
  decision_code text NOT NULL CHECK (length(decision_code) BETWEEN 1 AND 64),
  trace_id text NOT NULL CHECK (length(trace_id) BETWEEN 1 AND 128),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((target_type IS NULL) = (target_id IS NULL)),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (octet_length(metadata::text) <= 16384)
);

CREATE INDEX security_audit_events_meeting_created_idx
  ON security_audit_events (meeting_id, created_at DESC);
CREATE INDEX security_audit_events_created_idx ON security_audit_events (created_at);

-- Runtime grants are applied by deployment-specific roles, never to PUBLIC.
REVOKE ALL ON ALL TABLES IN SCHEMA hello_friend FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA hello_friend FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA hello_friend REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA hello_friend REVOKE ALL ON SEQUENCES FROM PUBLIC;
