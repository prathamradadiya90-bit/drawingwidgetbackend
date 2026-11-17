# Complete Postman Testing Guide: Knife Game Multiplayer

This guide provides end-to-end, step-by-step instructions for testing the **Knife Game Multiplayer** backend using **Postman**. It covers server setup, importing the Postman collection, executing all REST API HTTP endpoints (happy paths & error cases), and performing real-time multiplayer testing using Postman's native **Socket.IO client** with two concurrent players (Host Alice / Red and Guest Bob / Blue).

---

## Table of Contents

1. [Architecture & Game Rules Overview](#1-architecture--game-rules-overview)
2. [Prerequisites & Server Startup](#2-prerequisites--server-startup)
3. [Importing Collection into Postman](#3-importing-collection-into-postman)
4. [Collection Variables Setup](#4-collection-variables-setup)
5. [Testing REST API Endpoints (Step-by-Step)](#5-testing-rest-api-endpoints-step-by-step)
   - [Step 5.1: Health & Database Check (`GET /health`)](#step-51-health--database-check-get-health)
   - [Step 5.2: Create Knife Game (Host - Player Red) (`POST /api/v1/knife`)](#step-52-create-knife-game-host---player-red-post-apiv1knife)
   - [Step 5.3: Join Knife Game via Code (Guest - Player Blue) (`POST /api/v1/knife/join`)](#step-53-join-knife-game-via-code-guest---player-blue-post-apiv1knifejoin)
   - [Step 5.4: Get Knife Game Details by ID (`GET /api/v1/knife/:id`)](#step-54-get-knife-game-details-by-id-get-apiv1knifeid)
   - [Step 5.5: Get Knife Game Details by Code (`GET /api/v1/knife/code/:code`)](#step-55-get-knife-game-details-by-code-get-apiv1knifecodecode)
6. [Testing REST Validation & Error Cases](#6-testing-rest-validation--error-cases)
   - [Error 6.1: Missing `x-user-id` Header (`401 Unauthorized`)](#error-61-missing-x-user-id-header-401-unauthorized)
   - [Error 6.2: Non-existent Game Code (`404 Not Found`)](#error-62-non-existent-game-code-404-not-found)
   - [Error 6.3: Third Player Joins Full Game (`409 Conflict`)](#error-63-third-player-joins-full-game-409-conflict)
7. [Testing Real-Time Socket.IO Gameplay in Postman](#7-testing-real-time-socketio-gameplay-in-postman)
   - [Step 7.1: Opening Dual Postman Socket.IO Windows](#step-71-opening-dual-postman-socketio-windows)
   - [Step 7.2: Connection & Handshake Authentication](#step-72-connection--handshake-authentication)
   - [Step 7.3: Subscribing to Server Events](#step-73-subscribing-to-server-events)
   - [Step 7.4: Joining the Game Room (`knife:game:join`)](#step-74-joining-the-game-room-knifegamejoin)
   - [Step 7.5: Playing a Full Game (Throw by Throw)](#step-75-playing-a-full-game-throw-by-throw)
   - [Step 7.6: Testing Turn Enforcement & Illegal Throws](#step-76-testing-turn-enforcement--illegal-throws)
   - [Step 7.7: Testing Clank Hit (Losing a Heart)](#step-77-testing-clank-hit-losing-a-heart)
   - [Step 7.8: Testing Apple Cutting (+1 Point each)](#step-78-testing-apple-cutting-1-point-each)
   - [Step 7.9: Testing Game Over (Higher Score Wins!)](#step-79-testing-game-over-higher-score-wins)
   - [Step 7.10: Testing Rematch Request & Response (`knife:rematch:*`)](#step-710-testing-rematch-request--response-kniferematch)
   - [Step 7.11: Testing Voluntary Leave & Forfeit (`knife:game:leave`)](#step-711-testing-voluntary-leave--forfeit-knifegameleave)
   - [Step 7.12: Testing 60-Second Disconnect & Forfeit Window](#step-712-testing-60-second-disconnect--forfeit-window)
8. [Running Automated Tests via Postman Collection Runner](#8-running-automated-tests-via-postman-collection-runner)
9. [Error Codes & Troubleshooting Reference](#9-error-codes--troubleshooting-reference)

---

## 1. Architecture & Game Rules Overview

The backend uses a **server-authoritative** multiplayer model:
- **Server Owns the Score**: The thrower's phone sends the landing angle on the log (`0° - 360°`), and the server decides everything: clank or stick, apples cut, points, hearts, level cleared, and the winner.
- **Angle Gap Formula**:
  $$d = |a - b| \bmod 360, \quad \text{gap} = \min(d,\ 360 - d)$$
- **Clank Rule**: If the gap to ANY stuck knife is under **`13.5°`**, it's a **clank**. The thrower loses 1 heart, the knife is NOT added to the log, and 0 points are awarded.
- **Stick Rule**: Otherwise, the knife sticks in the log. Every uncut apple within **`14°`** is cut (+1 point per cut apple).
- **Level Cleared**: When all apples are cut, the log advances to Level + 1 (`level_started_at = now + 1,000ms`, stuck knives cleared, and new apples spawned: `min(2 + 2 * level, 20)`).
- **Crucial Win Condition**: The game ends when either player's hearts reach `0`. **The player with the HIGHER SCORE wins, NOT the player with hearts left!** Hearts never decide the winner; they only trigger the end of the match. If scores are tied: `is_draw: true`, `winner: null`.
- **Turns & Rematches**: Turns alternate after every throw (stick or clank). Round 1 starts with `red`; Round 2 (rematch) starts with `blue`.

---

## 2. Prerequisites & Server Startup

### Step 2.1: Verify Database Configuration
Make sure `.env` has your PostgreSQL connection string:
```env
PORT=3000
NODE_ENV=development
DATABASE_URL=postgres://postgres@localhost:5432/drawing_widget_ios
DATABASE_SSL=false
```

### Step 2.2: Run Database Migrations
Apply the migrations (creates `knife_games`, `knife_players`, `knife_throws`):
```bash
npm run db:migrate
```

### Step 2.3: Start the Server
```bash
npm run dev
```

---

## 3. Importing Collection into Postman

You have two pre-configured collection files available:
- **Dedicated Knife Game Collection**: `knife_postman_collection.json`
- **Full Backend Unified Collection**: `postman_collection.json`

### Import Instructions:
1. Open **Postman**.
2. Click **Import** (top left).
3. Select `knife_postman_collection.json` from:
   ```text
   /Users/pc/Documents/Drawingwidgetiosdeploy/knife_postman_collection.json
   ```
4. Click **Import**. You will see the collection **"Knife Game Multiplayer API & WebSockets"** in your sidebar.

---

## 4. Collection Variables Setup

Click on the collection name in Postman -> **Variables** tab:

| Variable Name | Initial Value | Current Value | Description |
| :--- | :--- | :--- | :--- |
| `base_url` | `http://localhost:3000` | `http://localhost:3000` | Local server or Render URL |
| `knife_user_host` | `knife_user_host_001` | `knife_user_host_001` | Host User ID (Red Player) |
| `knife_user_guest` | `knife_user_guest_002` | `knife_user_guest_002` | Guest User ID (Blue Player) |
| `knife_game_id` | *(auto-populated)* | *(auto-populated)* | UUID of created Knife Game |
| `knife_game_code` | *(auto-populated)* | *(auto-populated)* | 6-char alphanumeric room code |

---

## 5. Testing REST API Endpoints (Step-by-Step)

### Step 5.1: Health & Database Check (`GET /health`)
- **Method**: `GET`
- **URL**: `{{base_url}}/health`

#### Expected Response (`200 OK`):
```json
{
  "status": "ok",
  "database": "connected"
}
```

---

### Step 5.2: Create Knife Game (Host - Player Red) (`POST /api/v1/knife`)
- **Method**: `POST`
- **URL**: `{{base_url}}/api/v1/knife`
- **Headers**:
  - `Content-Type`: `application/json`
  - `x-user-id`: `{{knife_user_host}}`
  - `devicetype`: `ios`
- **Body (raw JSON)**:
  ```json
  {
    "name": "Alice (Host)",
    "profile_image": "A7"
  }
  ```

#### Expected Response (`201 Created`):
```json
{
  "success": true,
  "data": {
    "game": {
      "id": "e4b3c2d1-0000-4000-8000-abcdef123456",
      "code": "KM8Y2X",
      "host_id": "knife_user_host_001",
      "status": "waiting",
      "round": 1,
      "level": 1,
      "level_started_at": 0,
      "server_time": 1795400000000,
      "current_turn": null,
      "throw_number": 0,
      "scores": { "red": 0, "blue": 0 },
      "lives": { "red": 3, "blue": 3 },
      "apples": [
        { "index": 0, "angle": 35.0, "cut": false, "cut_by": null },
        { "index": 1, "angle": 125.0, "cut": false, "cut_by": null },
        { "index": 2, "angle": 215.0, "cut": false, "cut_by": null },
        { "index": 3, "angle": 305.0, "cut": false, "cut_by": null }
      ],
      "stuck_knives": [],
      "winner": null,
      "winner_user_id": null,
      "is_draw": false,
      "end_reason": null,
      "config": {
        "lives": 3,
        "knife_touch_deg": 13.5,
        "apple_touch_deg": 14,
        "level_pause_ms": 1000
      }
    },
    "color": "red",
    "players": [
      {
        "user_id": "knife_user_host_001",
        "color": "red",
        "name": "Alice (Host)",
        "profile_image": "A7"
      }
    ]
  },
  "message": "Game created successfully."
}
```

---

### Step 5.3: Join Knife Game via Code (Guest - Player Blue) (`POST /api/v1/knife/join`)
- **Method**: `POST`
- **URL**: `{{base_url}}/api/v1/knife/join`
- **Headers**:
  - `Content-Type`: `application/json`
  - `x-user-id`: `{{knife_user_guest}}`
  - `devicetype`: `ios`
- **Body (raw JSON)**:
  ```json
  {
    "code": "{{knife_game_code}}",
    "name": "Bob (Guest)",
    "profile_image": "B3"
  }
  ```

#### Expected Response (`200 OK`):
```json
{
  "success": true,
  "data": {
    "game": {
      "id": "e4b3c2d1-0000-4000-8000-abcdef123456",
      "code": "KM8Y2X",
      "status": "playing",
      "current_turn": "red",
      "level_started_at": 1795400001000
    },
    "color": "blue",
    "players": [
      { "user_id": "knife_user_host_001", "color": "red", "name": "Alice (Host)", "profile_image": "A7" },
      { "user_id": "knife_user_guest_002", "color": "blue", "name": "Bob (Guest)", "profile_image": "B3" }
    ]
  },
  "message": "Joined game successfully."
}
```

---

### Step 5.4: Get Knife Game Details by ID (`GET /api/v1/knife/:id`)
- **Method**: `GET`
- **URL**: `{{base_url}}/api/v1/knife/{{knife_game_id}}`

#### Expected Response (`200 OK`):
Returns the full game object, players list, and `config` tuning dictionary.

---

### Step 5.5: Get Knife Game Details by Code (`GET /api/v1/knife/code/:code`)
- **Method**: `GET`
- **URL**: `{{base_url}}/api/v1/knife/code/{{knife_game_code}}`

#### Expected Response (`200 OK`):
Resolves the game object by the 6-character room code.

---

## 6. Testing REST Validation & Error Cases

### Error 6.1: Missing `x-user-id` Header (`401 Unauthorized`)
- **Method**: `POST`
- **URL**: `{{base_url}}/api/v1/knife`
- **Body**: `{ "name": "Anonymous" }`
- **Expected Status**: `401 Unauthorized`
- **Response**: `{ "success": false, "error": "Missing or invalid user id header (x-user-id)" }`

---

### Error 6.2: Non-existent Game Code (`404 Not Found`)
- **Method**: `POST`
- **URL**: `{{base_url}}/api/v1/knife/join`
- **Body**: `{ "code": "ZZZZZZ", "name": "Bob" }`
- **Expected Status**: `404 Not Found`
- **Response**: `{ "success": false, "error": "No game found with code ZZZZZZ" }`

---

### Error 6.3: Third Player Joins Full Game (`409 Conflict`)
- **Method**: `POST`
- **URL**: `{{base_url}}/api/v1/knife/join`
- **Headers**: `x-user-id: knife_user_intruder_003`
- **Body**: `{ "code": "{{knife_game_code}}", "name": "Charlie" }`
- **Expected Status**: `409 Conflict`
- **Response**: `{ "success": false, "error": "This game is full or has already ended" }`

---

## 7. Testing Real-Time Socket.IO Gameplay in Postman

Postman features a native **Socket.IO client**.

### Step 7.1: Opening Dual Postman Socket.IO Windows
1. In Postman, click **New** -> **Socket.IO**.
2. Save Tab 1 as **"Player 1 (Alice - Red)"**.
3. Open a second Socket.IO tab and save it as **"Player 2 (Bob - Blue)"**.

---

### Step 7.2: Connection & Handshake Authentication

#### Tab 1 (Host Alice - Red):
- **URL**: `http://localhost:3000/v1`
- **Headers**:
  - `x-user-id`: `knife_user_host_001`
  - `devicetype`: `ios`
  - `name`: `Alice (Host)`
- Click **Connect** (Status turns green).

#### Tab 2 (Guest Bob - Blue):
- **URL**: `http://localhost:3000/v1`
- **Headers**:
  - `x-user-id`: `knife_user_guest_002`
  - `devicetype`: `ios`
  - `name`: `Bob (Guest)`
- Click **Connect** (Status turns green).

---

### Step 7.3: Subscribing to Server Events

Add these listeners in the **Events** panel on both tabs:
1. `knife:player:joined`
2. `knife:game:started`
3. `knife:thrown`
4. `knife:game:over`
5. `knife:rematch:requested`
6. `knife:rematch:declined`
7. `knife:game:restarted`
8. `knife:player:disconnected`
9. `knife:player:left`
10. `app:error`

---

### Step 7.4: Joining the Game Room (`knife:game:join`)

Both players emit `knife:game:join` with their game UUID:

```json
{
  "game_id": "YOUR_GAME_UUID_HERE"
}
```
*(Check the **Ack** checkbox before sending)*

#### Server Ack Response:
```json
{
  "ok": true,
  "your_color": "red",
  "game": { "status": "playing", "current_turn": "red", ... },
  "players": [ ... ]
}
```

---

### Step 7.5: Playing a Full Game (Throw by Throw)

#### Throw 1: Alice (Red) throws at Apple 0's angle
- **Tab 1 (Alice)**:
  - Event: `knife:throw`
  - Ack: Checked
  - Body:
    ```json
    {
      "game_id": "YOUR_GAME_UUID",
      "throw_number": 1,
      "level": 1,
      "angle": 35.0
    }
    ```
  - Click **Send**.
  - **Ack Output**:
    ```json
    {
      "ok": true,
      "result": "stick",
      "apples_cut": [0],
      "points": 1,
      "scores": { "red": 1, "blue": 0 },
      "lives": { "red": 3, "blue": 3 },
      "next_turn": "blue",
      "next_throw_number": 2,
      "level_cleared": false,
      "next_level": null,
      "game_over": false
    }
    ```
- **Tab 2 (Bob)**:
  - Instantly receives event **`knife:thrown`** with the identical result!

---

### Step 7.6: Testing Turn Enforcement & Illegal Throws

In **Bob's Tab** (Tab 2), if Bob tries to throw while it's Red's turn:
- Event: `knife:throw`
- **Server Ack Output**:
  ```json
  {
    "ok": false,
    "code": "THROW_FAILED",
    "reason": "NOT_YOUR_TURN",
    "error": "It is not your turn"
  }
  ```

---

### Step 7.7: Testing Clank Hit (Losing a Heart)

Now it is Bob's turn (`next_turn: "blue"`). Alice stuck a knife at `35.0°`.
If Bob throws at `38.0°` (angle gap = `3.0° < 13.5°`):
- **Tab 2 (Bob)**:
  - Event: `knife:throw`
  - Body: `{ "game_id": "...", "throw_number": 2, "level": 1, "angle": 38.0 }`
  - Click **Send**.
  - **Server Ack Output**:
    ```json
    {
      "ok": true,
      "result": "clank",
      "apples_cut": [],
      "points": 0,
      "scores": { "red": 1, "blue": 0 },
      "lives": { "red": 3, "blue": 2 },
      "next_turn": "red",
      "next_throw_number": 3,
      "level_cleared": false,
      "game_over": false
    }
    ```
  *(Notice: Bob lost 1 heart! The knife was NOT stuck in the log).*

---

### Step 7.8: Testing Apple Cutting (+1 Point each)

- Angle gap formula determines whether an uncut apple is within `14.0°`.
- When a knife hits within `14°` of an apple, `apple.cut` is set to `true`, and the thrower receives `+1 point` per cut apple (one knife can cut 2 apples if placed between them!).

---

### Step 7.9: Testing Game Over (Higher Score Wins!)

When either player's lives reach `0`, the server ends the game:
- **Tab 1 & Tab 2 receive broadcast event `knife:game:over`**:
  ```json
  {
    "status": "finished",
    "winner": "red",
    "winner_user_id": "knife_user_host_001",
    "is_draw": false,
    "reason": "SCORE",
    "scores": { "red": 4, "blue": 1 },
    "lives": { "red": 2, "blue": 0 },
    "level": 1
  }
  ```
> **Remember**: The player with the **HIGHER SCORE** wins, not the player with lives left!

---

### Step 7.10: Testing Rematch Request & Response (`knife:rematch:*`)

1. **Host Alice requests rematch**:
   - In Tab 1: Emit `knife:rematch:request` with `{ "game_id": "..." }`
   - Bob receives event: `knife:rematch:requested` with `{ "user_id": "knife_user_host_001" }`.
2. **Bob accepts rematch**:
   - In Tab 2: Emit `knife:rematch:respond` with `{ "game_id": "...", "accept": true }`
   - **Both tabs receive broadcast event `knife:game:restarted`**:
     - `round`: `2`
     - `scores`: `{ "red": 0, "blue": 0 }`
     - `lives`: `{ "red": 3, "blue": 3 }`
     - `current_turn`: **`"blue"`** *(Blue starts Round 2!)*
     - `level`: `1`

---

### Step 7.11: Testing Voluntary Leave & Forfeit (`knife:game:leave`)

- If Bob emits `knife:game:leave` during an active game:
  - Alice receives `knife:player:left`.
  - Alice receives `knife:game:over` with `{ "status": "abandoned", "winner": "red", "reason": "OPPONENT_LEFT" }`.

---

### Step 7.12: Testing 60-Second Disconnect & Forfeit Window

1. Disconnect Bob's socket.
2. Alice receives `knife:player:disconnected`: `{ "user_id": "knife_user_guest_002", "timeout_ms": 60000 }`.
3. If Bob reconnects and sends `knife:game:join` within 60s, game continues.
4. If 60s expires, Alice is awarded the win by forfeit (`OPPONENT_DISCONNECTED`).

---

## 8. Running Automated Tests via Postman Collection Runner

1. Click on the collection **"Knife Game Multiplayer API & WebSockets"**.
2. Click **Run**.
3. Select the folder **"2. Knife Game REST Endpoints"**.
4. Set Iterations: `1`, Delay: `0 ms`.
5. Click **Run Knife Game Multiplayer API & WebSockets**.
6. **All tests pass with 100% Green Checks!**

---

## 9. Error Codes & Troubleshooting Reference

| Error Code | Reason | Description | Resolution |
| :--- | :--- | :--- | :--- |
| `THROW_FAILED` | `GAME_NOT_ACTIVE` | Throw sent before game started or after game ended | Wait for opponent to join or start rematch |
| `THROW_FAILED` | `NOT_YOUR_TURN` | Throw sent when it is opponent's turn | Wait for opponent's throw |
| `THROW_FAILED` | `STALE_THROW` | `throw_number` or `level` does not match server | Use `next_throw_number` from last ack |
| `THROW_FAILED` | `LEVEL_STARTING` | Throw before `level_started_at` delay | Wait for log spin start time |
| `THROW_FAILED` | `INVALID_ANGLE` | Angle is not a number between 0 and 360 | Pass valid decimal angle `0..360` |
| `REMATCH_FAILED`| `GAME_NOT_FINISHED` | Rematch requested while game still in progress | Play until game finishes |
| `REMATCH_FAILED`| `OPPONENT_LEFT` | Rematch requested after opponent left | Return to lobby |
| `NOT_IN_GAME` | `NOT_IN_GAME` | Socket did not join game | Emit `knife:game:join` first |

