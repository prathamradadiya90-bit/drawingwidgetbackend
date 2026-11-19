-- Enable pgcrypto for UUID generation if needed
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table
CREATE TABLE IF NOT EXISTS users (
    user_id       TEXT PRIMARY KEY,
    friend_code   CHAR(8) NOT NULL UNIQUE,
    name          VARCHAR(20) NOT NULL DEFAULT 'Player',
    profile_image VARCHAR(100) NOT NULL DEFAULT 'A1',
    device_id     VARCHAR(255),
    platform      VARCHAR(20) NOT NULL DEFAULT 'ios',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_friend_code ON users(friend_code);
CREATE INDEX IF NOT EXISTS idx_users_device_id ON users(device_id);

-- Friendships table (one row per mutual pair: user_a < user_b)
CREATE TABLE IF NOT EXISTS friendships (
    user_a        TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    user_b        TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_by    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_a, user_b),
    CONSTRAINT chk_friendships_user_order CHECK (user_a < user_b)
);

CREATE INDEX IF NOT EXISTS idx_friendships_user_b ON friendships(user_b);
CREATE INDEX IF NOT EXISTS idx_friendships_created_at ON friendships(created_at DESC);

