# Drawing Widget iOS Backend

Production-ready Node.js (ES Modules) backend API with **Multiplayer Rooms** and **Real-Time Live Drawing** for the Drawing Widget application.

---

## Features
- **Tic Tac Toe (two-player)**:
  - Server-authoritative turns, win and draw detection over Socket.IO.
  - Joined with a 6-character code; iOS and Android players can play each other.
  - Rematches, move history, and a 60-second reconnect window before a dropped player forfeits.
- **Multiplayer Room System**:
  - Room creation with unique 6-character room codes (e.g. `S3W7FZ`).
  - Host and guest slot allocation (2 to 4 player slots).
  - Atomic concurrency protection with PostgreSQL transactions (`FOR UPDATE` locking).
  - Platform check & slot retention on player reconnect.
- **Live Drawing & Real-Time Synchronization**:
  - Ultra low-latency point streaming (`stroke:move`) for instantaneous pen tracking.
  - Asynchronous stroke persistence (`stroke:add` -> PostgreSQL `room_strokes`).
  - Stroke erasing and canvas backfill on room join.
  - Token-bucket rate limiting (50 ops/sec, burst 200) to protect against spam.
  - Multi-platform support (`ios` with `PKDrawing` base64 & `android`).
- **Clean Architecture & Maintainability**:
  - Separation of Concerns: Config, Controllers, Services, Middlewares, Sockets, Helpers.
  - Automated database schema migrations (`npm run db:migrate`).
  - Graceful shutdown for HTTP server, Socket.IO, and PostgreSQL connection pool.
  - End-to-end automated integration tests (`npm test`).

---

## Project Structure

```text
.
├── .env                              # Environment variables
├── .env.example                      # Environment variables template
├── package.json
├── src/
│   ├── app.js                        # Express app, health checks & middlewares
│   ├── server.js                     # HTTP server, Socket.IO & graceful shutdown
│   ├── config/
│   │   ├── index.js                  # Centralized configuration
│   │   └── db.js                     # PostgreSQL connection pool & transaction helper
│   ├── controllers/
│   │   └── room.controller.js        # Multiplayer HTTP controllers
│   ├── database/
│   │   ├── schema.sql                # Tables, indexes, and constraints
│   │   └── migrate.js               # Database migration runner
│   ├── helpers/
│   │   ├── constants.js              # Socket events, limits, room rules
│   │   ├── logger.js                 # Structured logger
│   │   └── response.helper.js        # Standardized API response wrappers
│   ├── middlewares/
│   │   ├── auth.middleware.js        # Header authentication (x-user-id, devicetype)
│   │   └── error.middleware.js       # Centralized 404 & error handlers
│   ├── routes/
│   │   ├── index.js                  # API router (/api/v1/...)
│   │   └── room.routes.js            # Room endpoints
│   ├── services/
│   │   ├── room.service.js           # Room creation, joining, slot allocation
│   │   ├── stroke.service.js         # Stroke storage, erasing, queries
│   │   ├── chat.service.js           # Real-time room chat persistence
│   │   └── reaper.service.js         # Periodic idle room cleanup
│   └── sockets/
│       ├── auth.socket.js            # Handshake authentication & device detection
│       ├── events.js                 # Real-time live drawing event listeners
│       ├── rateLimiter.js            # Token bucket rate limiter
│       └── index.js                  # Socket.IO server initialization
└── test/
    └── test_multiplayer.js           # End-to-end integration test suite
```

---

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Set database connection parameters in `.env`:
```bash
PORT=3000
NODE_ENV=development
DATABASE_URL=postgres://user:password@host:5432/dbname
DATABASE_SSL=false
ROOM_TTL_HOURS=24
ROOM_REAP_INTERVAL_MINUTES=60
```

### 3. Run Database Migrations
```bash
npm run db:migrate
```

### 4. Run the Server
```bash
# Development Mode (auto-reload on change)
npm run dev

# Production Mode
npm start
```

### 5. Run Automated Tests
```bash
npm test
```

### 6. Postman Testing Guides
- 🎮 **Tic-Tac-Toe Testing Guide**: [TICTACTOE_POSTMAN_TESTING_GUIDE.md](TICTACTOE_POSTMAN_TESTING_GUIDE.md) (Dedicated Postman collection: `tictactoe_postman_collection.json`)
- 🎨 **Multiplayer Drawing Rooms Testing Guide**: [POSTMAN_TESTING_GUIDE.md](POSTMAN_TESTING_GUIDE.md) (Full backend collection: `postman_collection.json`)

---

## API Documentation

### HTTP Headers
Every authenticated request requires:
- `x-user-id`: Client user identifier (string)
- `devicetype`: `ios` or `android` (optional, defaults to `ios`)

### Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/ping` | Lightweight cold-start wakeup (instant 200, no DB query) |
| `GET` | `/health` | Health check (verifies database connectivity) |
| `POST` | `/api/v1/rooms/` | Create a multiplayer room (`svg_resource` optional) |
| `POST` | `/api/v1/rooms/join` | Join an existing room via 6-character code |
| `POST` | `/api/v1/rooms/leave` | Leave a room (host departure closes room for all) |
| `GET` | `/api/v1/rooms/:id` | Get room metadata and active member list |
| `GET` | `/api/v1/rooms/:id/strokes` | Get historical strokes for canvas backfill |

---

## Socket.IO Events (`/v1` namespace)

### Client -> Server (All actions accept an optional ack callback `(response) => {}`)
- `room:join`: `{ room_id }`
- `room:leave`: `{}`
- `stroke:move`: `{ id, kind, stroke_data, step_index? }` *(Relayed live with zero DB latency)*
- `stroke:add`: `{ id, kind, stroke_data, step_index? }` *(Broadcasted live & asynchronously saved to DB)*
  - **Line / Fill**: `kind: "line" | "fill"`, `stroke_data: "<base64>"`
  - **Shape**: `kind: "shape"`, fields: `shape_type`, `stroke_id`, `fill_id`, `stroke_width`, `coordinates: { x, y }`, `size: { width, height }`, `angle`
  - **Emoji**: `kind: "emoji"`, fields: `emoji_id`, `coordinates: { x, y }`, `size: { width, height }`, `angle`
- `stroke:erase`: `{ stroke_ids: [...], step_index? }` *(Only the creator of a stroke can erase it)*
- `chat:add`: `{ message }`

### Server -> Client
- `presence:join`: `{ user_id, name, slot_index }`
- `presence:leave`: `{ user_id }` *(Sent after 5s disconnect grace period)*
- `stroke:move`: `{ id, kind, stroke_data, user_id, step_index? }`
- `stroke:add`: `{ id, room_id, user_id, kind, stroke_data, created_at, step_index? }`
- `stroke:saved`: `{ id, ok: true, duplicate?: boolean }` *(Sent upon successful DB save)*
- `stroke:error`: `{ id?, code, error, event }` *(Sent when stroke validation or persistence fails)*
- `room:closed`: `{ reason: "HOST_LEFT" | "HOST_DISCONNECTED", message: "..." }`
- `stroke:backfill`: `{ strokes: [...] }`
- `chat:backfill`: `{ chats: [...] }`
- `error`: `{ code, error, event }` *(Standard error event for UI handling)*

### Standard Error Codes for UI Handling

| Code | Description | Recommended UI Action |
|---|---|---|
| `NOT_IN_ROOM` | Socket not currently joined to a room channel | Call `room:join` before drawing |
| `NOT_A_MEMBER` | User did not join room via REST API | Prompt user to enter room code again |
| `ROOM_NOT_FOUND` | Room does not exist or has expired | Navigate back to lobby |
| `ROOM_CLOSED` | Host left or disconnected | Display "Host left the session" dialog |
| `ROOM_FULL` | Room has reached maximum player capacity (2-4) | Display "Room is full" message |
| `PLATFORM_MISMATCH` | Joining iOS room from Android or vice versa | Display platform mismatch message |
| `UNAUTHORIZED_ERASE` | Attempted to erase strokes owned by another user | Ignore or revert local canvas erase |
| `INVALID_STROKE_ID` | Missing or invalid UUID | Ensure UUIDv4 is used for stroke IDs |
| `INVALID_STROKE_DATA` | Empty or malformed stroke data | Validate drawing points before emit |
| `PAYLOAD_TOO_LARGE` | Stroke payload exceeds maximum limit (100MB) | Simplify or compress stroke data |
| `RATE_LIMIT_EXCEEDED` | Exceeded 50 strokes/sec (burst 200) | Throttle pen move emissions |
| `SAVE_FAILED` | Database write error on stroke | Retry sending stroke after delay |

---

## Tic Tac Toe

The server owns all game state: clients send a cell, then render the `board` they get back. Cells are numbered `0`-`8`, left to right and top to bottom.

**Flow**
1. Host calls `POST /api/v1/tictactoe`, plays `X`, and shares `game.code`.
2. Guest calls `POST /api/v1/tictactoe/join`, plays `O`. The game is now `playing`.
3. Both connect a socket and emit `ttt:game:join`. The host's `ttt:player:joined` event is the signal to leave the waiting screen.
4. `X` moves first, then players alternate with `ttt:move` until `ttt:game:over`.
5. Either player can emit `ttt:restart`. Symbols swap so the other player goes first, so re-read `your_symbol` or `players` after a rematch.

### Endpoints

| Method | Endpoint | Body / Notes |
|---|---|---|
| `POST` | `/api/v1/tictactoe` | `{ name?, profile_image? }`, returns `{ game, symbol, players }` |
| `POST` | `/api/v1/tictactoe/join` | `{ code, name?, profile_image? }`, returns `{ game, symbol, players }`. Safe to retry |
| `GET` | `/api/v1/tictactoe/:id` | Returns `{ game, players }` |
| `GET` | `/api/v1/tictactoe/code/:code` | Returns `{ game, players }` |
| `GET` | `/api/v1/tictactoe/:id/moves` | Returns `{ moves }` for the current round |

`game`:
```json
{
  "id": "uuid", "code": "S3W7FZ", "host_id": "user-1",
  "status": "waiting | playing | finished | abandoned",
  "board": ["X", null, null, null, "O", null, null, null, null],
  "current_turn": "X", "winner": null, "winning_line": null, "is_draw": false,
  "end_reason": null, "round": 1, "move_count": 2,
  "created_at": "...", "started_at": "...", "finished_at": null
}
```

`players[]`: `{ user_id, symbol, name, profile_image, device_type, joined_at, left_at }`

### Client -> Server (use the ack callback for the result)

| Event | Payload | Ack on success |
|---|---|---|
| `ttt:game:join` | `{ game_id }` | `{ ok, your_symbol, game, players }` |
| `ttt:move` | `{ cell_index }` | `{ ok, ...move }` (see `ttt:move:made`) |
| `ttt:restart` | `{}` | `{ ok, status, move_count, your_symbol, game, players }` |
| `ttt:game:leave` | `{}` | `{ ok, game_abandoned }` |

Failed acks are `{ ok: false, code, reason, error, event }`.

### Server -> Client

| Event | Payload | Sent to |
|---|---|---|
| `ttt:player:joined` | `{ game_id, user_id, game, players }` | Opponent. Also means a disconnected player is back |
| `ttt:player:disconnected` | `{ game_id, user_id, timeout_ms }` | Opponent |
| `ttt:player:left` | `{ game_id, user_id }` | Opponent |
| `ttt:move:made` | `{ game_id, user_id, cell_index, symbol, move_number, next_turn, board, game_over, winner, winning_line, is_draw }` | Opponent |
| `ttt:game:over` | `{ game_id, status, winner, winner_user_id, winning_line, is_draw, reason, board }` | Both players |
| `ttt:game:restarted` | `{ game_id, restarted_by, game, players }` | Opponent |

`ttt:game:over` `reason` is `WIN`, `DRAW`, `OPPONENT_LEFT` or `OPPONENT_DISCONNECTED`.

### Rules for Leaving and Disconnecting
- **Reconnecting**: emit `ttt:game:join` again to get the full game state. Do this within 60 seconds or the opponent wins by forfeit.
- **Leaving** a `playing` game forfeits it (`status: abandoned`, opponent is `winner`). Leaving a `waiting` game cancels it. Leaving a `finished` game keeps the result but rules out a rematch.
- **Waiting games** survive the host disconnecting, so the host can switch apps to share the code.
- If both players tap rematch, the second `ttt:restart` fails with `GAME_NOT_FINISHED`. Ignore it, since `ttt:game:restarted` is already on its way.

### Error Codes

| `code` | `reason` | Recommended UI Action |
|---|---|---|
| `MOVE_FAILED` | `NOT_YOUR_TURN`, `CELL_OCCUPIED`, `GAME_NOT_ACTIVE`, `INVALID_CELL`, `NOT_IN_GAME` | Re-render from the last `board` received |
| `RESTART_FAILED` | `GAME_NOT_FINISHED`, `OPPONENT_LEFT`, `NOT_IN_GAME` | Hide the rematch option |
| `GAME_NOT_FOUND` | `GAME_NOT_FOUND` | Navigate back to lobby |
| `NOT_IN_GAME` | `NOT_IN_GAME` | Prompt user to enter the game code again |
