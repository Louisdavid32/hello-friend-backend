-- Preserve each participant's durable visibility floor for strict-membership history.
ALTER TABLE hello_friend.participants
  ADD COLUMN chat_join_position bigint NOT NULL DEFAULT 0
  CHECK (chat_join_position >= 0);

-- Existing participants must not gain history that predates rollout of this invariant.
UPDATE hello_friend.participants AS participant
SET chat_join_position = stream.last_position
FROM hello_friend.meeting_stream_heads AS stream
WHERE stream.meeting_id = participant.meeting_id;

-- Support policy slow mode and bounded participant-specific operational investigations.
CREATE INDEX chat_messages_sender_created_idx
  ON hello_friend.chat_messages (meeting_id, sender_participant_id, created_at DESC);
