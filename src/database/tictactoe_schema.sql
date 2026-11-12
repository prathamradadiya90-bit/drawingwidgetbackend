-- Tic Tac Toe games. The board is 9 chars ('X', 'O' or '-' for empty), cells 0-8 left to right, top to bottom.
CREATE TABLE IF NOT EXISTS ttt_games (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code          TEXT NOT NULL UNIQUE,
    host_id       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'playing', 'finished', 'abandoned')),
    board         TEXT NOT NULL DEFAULT '---------' CHECK (board ~ '^[XO-]{9}$'),
    current_turn  TEXT CHECK (current_turn IN ('X', 'O')),
    winner        TEXT CHECK (winner IN ('X', 'O')),
    winning_line  INT[],
    end_reason    TEXT CHECK (end_reason IN ('WIN', 'DRAW', 'OPPONENT_LEFT', 'OPPONENT_DISCONNECTED')),
    round         INT NOT NULL DEFAULT 1,
    move_count    INT NOT NULL DEFAULT 0 CHECK (move_count BETWEEN 0 AND 9),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ttt_games_updated_at ON ttt_games (updated_at);

-- Exactly two players per game. The symbol constraint is deferred so a rematch can swap X and O in one UPDATE.
CREATE TABLE IF NOT EXISTS ttt_players (
    game_id        UUID NOT NULL REFERENCES ttt_games(id) ON DELETE CASCADE,
    user_id        TEXT NOT NULL,
    symbol         TEXT NOT NULL CHECK (symbol IN ('X', 'O')),
    name           TEXT,
    profile_image  TEXT,
    device_type    TEXT NOT NULL DEFAULT 'ios' CHECK (device_type IN ('ios', 'android')),
    joined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at        TIMESTAMPTZ,
    PRIMARY KEY (game_id, user_id),
    CONSTRAINT ttt_players_game_symbol_key UNIQUE (game_id, symbol) DEFERRABLE INITIALLY DEFERRED
);

-- Move history, kept per round so rematches do not overwrite earlier rounds.
CREATE TABLE IF NOT EXISTS ttt_moves (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id      UUID NOT NULL REFERENCES ttt_games(id) ON DELETE CASCADE,
    round        INT NOT NULL,
    move_number  INT NOT NULL CHECK (move_number BETWEEN 1 AND 9),
    user_id      TEXT NOT NULL,
    symbol       TEXT NOT NULL CHECK (symbol IN ('X', 'O')),
    cell_index   INT NOT NULL CHECK (cell_index BETWEEN 0 AND 8),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (game_id, round, move_number),
    UNIQUE (game_id, round, cell_index)
);
