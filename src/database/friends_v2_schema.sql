-- Friends v2 Schema Migration
-- Device Token (auth_token_hash), Friend Requests, and Notifications

-- 1. Device Token Hash on Users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_token_hash TEXT;

-- 2. Friend Requests table
CREATE TABLE IF NOT EXISTS friend_requests (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user_id  TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    to_user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    source        TEXT NOT NULL CHECK (source IN ('code', 'match')),
    game          TEXT NULL,
    status        TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')) DEFAULT 'pending',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    responded_at  TIMESTAMPTZ NULL
);

-- Unique index: At most one pending request per pair of users in either direction
CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pending_pair
    ON friend_requests (LEAST(from_user_id, to_user_id), GREATEST(from_user_id, to_user_id))
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_friend_requests_from_user ON friend_requests(from_user_id);
CREATE INDEX IF NOT EXISTS idx_friend_requests_to_user ON friend_requests(to_user_id);
CREATE INDEX IF NOT EXISTS idx_friend_requests_status_expires ON friend_requests(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_friend_requests_declined_cooldown ON friend_requests(from_user_id, to_user_id, status, responded_at);

-- 3. Notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    type          TEXT NOT NULL CHECK (type IN ('friend_request', 'missed_invite')),
    request_id    UUID NULL REFERENCES friend_requests(id) ON DELETE CASCADE,
    from_user_id  TEXT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    game          TEXT NULL,
    reason        TEXT NULL CHECK (reason IN ('OFFLINE', 'NO_ANSWER')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_request_id ON notifications(request_id);
CREATE INDEX IF NOT EXISTS idx_notifications_dedup ON notifications(user_id, from_user_id, game, type);
