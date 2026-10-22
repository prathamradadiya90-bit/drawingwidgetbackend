-- Enable pgcrypto for UUID generation if not already available
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Rooms table
CREATE TABLE IF NOT EXISTS rooms (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code          TEXT NOT NULL UNIQUE,
    svg_resource  TEXT NOT NULL,
    host_id       TEXT NOT NULL,
    player_count  INT NOT NULL DEFAULT 2 CHECK (player_count BETWEEN 2 AND 4),
    device_type   TEXT NOT NULL DEFAULT 'ios' CHECK (device_type IN ('ios', 'android')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rooms_code ON rooms(code);

-- Room Members table
CREATE TABLE IF NOT EXISTS room_members (
    room_id     UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    slot_index  INT,
    name        TEXT,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at     TIMESTAMPTZ,
    PRIMARY KEY (room_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS room_members_room_id_slot_index_uidx
    ON room_members (room_id, slot_index) WHERE slot_index IS NOT NULL;

-- iOS Room Strokes table (base64 PKDrawing)
CREATE TABLE IF NOT EXISTS room_strokes (
    id           UUID PRIMARY KEY,
    room_id      UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL,
    step_index   INT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'line' CHECK (kind IN ('line', 'fill')),
    stroke_data  TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_room_strokes_room_id_created_at
    ON room_strokes (room_id, created_at);

-- Android Room Strokes table (JSON drawing events)
CREATE TABLE IF NOT EXISTS room_android_strokes (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id      UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL,
    event_type   TEXT NOT NULL CHECK (event_type IN ('STROKE', 'UNDO', 'REDO', 'CLEAR', 'NEXT_STEP', 'COMPLETE_LESSON')),
    stroke_data  JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_room_android_strokes_room_id_created_at
    ON room_android_strokes (room_id, created_at);

-- Room Chat Messages table
CREATE TABLE IF NOT EXISTS room_chats (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id     UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    message     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_room_chats_room_id_created_at
    ON room_chats (room_id, created_at);
