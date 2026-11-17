-- Knife Game schema.
-- 2-player turn-based knife throwing game: red (host) and blue (joiner).
CREATE TABLE IF NOT EXISTS knife_games (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code              TEXT NOT NULL UNIQUE,
    host_id           TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'playing', 'finished', 'abandoned')),
    round             INT NOT NULL DEFAULT 1,
    level             INT NOT NULL DEFAULT 1,
    level_started_at  BIGINT NOT NULL DEFAULT 0,
    current_turn      TEXT CHECK (current_turn IN ('red', 'blue')),
    throw_number      INT NOT NULL DEFAULT 0,
    scores            JSONB NOT NULL DEFAULT '{"red": 0, "blue": 0}'::jsonb,
    lives             JSONB NOT NULL DEFAULT '{"red": 3, "blue": 3}'::jsonb,
    apples            JSONB NOT NULL DEFAULT '[]'::jsonb,
    stuck_knives      JSONB NOT NULL DEFAULT '[]'::jsonb,
    winner            TEXT CHECK (winner IN ('red', 'blue')),
    winner_user_id    TEXT,
    is_draw           BOOLEAN NOT NULL DEFAULT FALSE,
    end_reason        TEXT CHECK (end_reason IN ('SCORE', 'OPPONENT_LEFT', 'OPPONENT_DISCONNECTED')),
    config            JSONB NOT NULL DEFAULT '{"lives": 3, "knife_touch_deg": 13.5, "apple_touch_deg": 14, "level_pause_ms": 1000}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at        TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knife_games_updated_at ON knife_games (updated_at);

-- Exactly two players per game (red and blue).
CREATE TABLE IF NOT EXISTS knife_players (
    game_id        UUID NOT NULL REFERENCES knife_games(id) ON DELETE CASCADE,
    user_id        TEXT NOT NULL,
    color          TEXT NOT NULL CHECK (color IN ('red', 'blue')),
    name           TEXT,
    profile_image  TEXT,
    device_type    TEXT NOT NULL DEFAULT 'ios' CHECK (device_type IN ('ios', 'android')),
    joined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at        TIMESTAMPTZ,
    PRIMARY KEY (game_id, user_id),
    CONSTRAINT knife_players_game_color_key UNIQUE (game_id, color) DEFERRABLE INITIALLY DEFERRED
);

-- Throw history per round, level and throw_number
CREATE TABLE IF NOT EXISTS knife_throws (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id       UUID NOT NULL REFERENCES knife_games(id) ON DELETE CASCADE,
    round         INT NOT NULL,
    throw_number  INT NOT NULL,
    level         INT NOT NULL,
    user_id       TEXT NOT NULL,
    color         TEXT NOT NULL CHECK (color IN ('red', 'blue')),
    angle         DOUBLE PRECISION NOT NULL,
    result        TEXT NOT NULL CHECK (result IN ('stick', 'clank')),
    apples_cut    INT[] NOT NULL DEFAULT '{}',
    points        INT NOT NULL DEFAULT 0,
    scores        JSONB NOT NULL,
    lives         JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (game_id, round, throw_number)
);

