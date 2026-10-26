# Drawing Widget iOS Backend

Production-ready Node.js (ES Modules) backend API with **Multiplayer Rooms** and **Real-Time Live Drawing** for the Drawing Widget application.

---

## Features
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

