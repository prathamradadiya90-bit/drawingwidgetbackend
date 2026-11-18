-- Shoot Game schema.
-- 2-player turn-based target shooting game: blue (host) and red (friend).
CREATE TABLE IF NOT EXISTS shoot_games (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                TEXT NOT NULL UNIQUE,
    host_id             TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'playing', 'finished', 'abandoned')),
    round               INT NOT NULL DEFAULT 1,
    first_turn          TEXT NOT NULL DEFAULT 'blue' CHECK (first_turn IN ('blue', 'red')),
    current_turn        TEXT CHECK (current_turn IN ('blue', 'red')),
    shot_number         INT NOT NULL DEFAULT 0,
    scores              JSONB NOT NULL DEFAULT '{"blue": 0, "red": 0}'::jsonb,
    shots_left          JSONB NOT NULL DEFAULT '{"blue": 5, "red": 5}'::jsonb,
    turn_started_at     BIGINT,
    turn_deadline_at    BIGINT,
    turn_path_progress  DOUBLE PRECISION NOT NULL DEFAULT 0,
    turn_segment_ms     INT NOT NULL DEFAULT 800,
    turn_path           JSONB NOT NULL DEFAULT '[]'::jsonb,
    winner              TEXT CHECK (winner IN ('blue', 'red')),
    winner_user_id      TEXT,
    is_draw             BOOLEAN NOT NULL DEFAULT FALSE,
    end_reason          TEXT CHECK (end_reason IN ('SCORE', 'OPPONENT_LEFT', 'OPPONENT_DISCONNECTED')),
    config              JSONB NOT NULL DEFAULT '{"max_shots": 5, "path_length": 100, "range_x": 139, "range_y": 168, "target_size": 280, "base_segment_ms": 800, "segment_step_ms": 50, "result_pause_ms": 1200, "bullseye_pause_ms": 1600, "start_delay_ms": 1000, "late_slack_ms": 1500, "early_slack_ms": 250, "turn_timeout_ms": 15000}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at          TIMESTAMPTZ,
    finished_at         TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shoot_games_updated_at ON shoot_games (updated_at);

-- Exactly two players per game (blue and red).
CREATE TABLE IF NOT EXISTS shoot_players (
    game_id        UUID NOT NULL REFERENCES shoot_games(id) ON DELETE CASCADE,
    user_id        TEXT NOT NULL,
    color          TEXT NOT NULL CHECK (color IN ('blue', 'red')),
    name           TEXT,
    profile_image  TEXT,
    device_type    TEXT NOT NULL DEFAULT 'ios' CHECK (device_type IN ('ios', 'android')),
    joined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at        TIMESTAMPTZ,
    PRIMARY KEY (game_id, user_id),
    CONSTRAINT shoot_players_game_color_key UNIQUE (game_id, color) DEFERRABLE INITIALLY DEFERRED
);

-- Shot history per round and shot_number (10 shots total per round)
CREATE TABLE IF NOT EXISTS shoot_shots (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id       UUID NOT NULL REFERENCES shoot_games(id) ON DELETE CASCADE,
    round         INT NOT NULL,
    shot_number   INT NOT NULL,
    color         TEXT NOT NULL CHECK (color IN ('blue', 'red')),
    user_id       TEXT NOT NULL,
    x             DOUBLE PRECISION NOT NULL,
    y             DOUBLE PRECISION NOT NULL,
    points        INT NOT NULL,
    elapsed_ms    INT NOT NULL,
    adjusted      BOOLEAN NOT NULL DEFAULT FALSE,
    auto          BOOLEAN NOT NULL DEFAULT FALSE,
    path_progress DOUBLE PRECISION NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (game_id, round, shot_number)
);

CREATE INDEX IF NOT EXISTS idx_shoot_shots_game_round ON shoot_shots (game_id, round, shot_number);

