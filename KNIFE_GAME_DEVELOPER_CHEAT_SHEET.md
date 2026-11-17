# Knife Game: Frontend (iOS / Swift) Developer Integration Cheat Sheet

```text
================================================================================
          KNIFE GAME MULTIPLAYER API & SOCKET.IO DEVELOPER CHEAT SHEET
================================================================================

1. CONNECTION & HANDSHAKE AUTH:
--------------------------------------------------------------------------------
- Socket.IO URL:    https://<YOUR_BACKEND_URL>/v1   (or http://localhost:3000/v1)
- Namespace:        /v1
- Transport:        websocket
- Handshake Headers / Params:
    x-user-id:   "<USER_ID>"          (String, required, min 2 chars)
    devicetype:  "ios"                (String, "ios" or "android")
    name:        "<DISPLAY_NAME>"     (String, e.g. "Alice")
    profileImage: "A7"                (String, avatar identifier, e.g. "A7")


2. REST LOBBY ENDPOINTS:
--------------------------------------------------------------------------------
- POST /api/v1/knife
    Headers: x-user-id, devicetype, Content-Type: application/json
    Body:    { "name": "Alice", "profile_image": "A7" }
    Returns: { "game": {...}, "color": "red", "players": [...] }  (Status: 201)
    * Host is always color "red" and gets a 6-character room code.

- POST /api/v1/knife/join
    Headers: x-user-id, devicetype, Content-Type: application/json
    Body:    { "code": "KM8Y2X", "name": "Bob", "profile_image": "B3" }
    Returns: { "game": {...}, "color": "blue", "players": [...] }  (Status: 200)
    * Guest is always color "blue". Safe to retry with same userId.

- GET /api/v1/knife/:id
    Returns: { "game": {...}, "players": [...] }

- GET /api/v1/knife/code/:code
    Returns: { "game": {...}, "players": [...] }


3. GAME RULES & LOG COORDINATES:
--------------------------------------------------------------------------------
- Angle Space: 0.0° to 359.9° around the rotating log.
- Clank Rule:
    Distance to ANY stuck knife < 13.5° -> CLANK!
    Thrower loses 1 heart (lives - 1). Knife does NOT stick. 0 points.
- Stick Rule:
    Distance to all stuck knives >= 13.5° -> STICK!
    Knife sticks to log. Any uncut apple within < 14.0° is cut. +1 point each.
- Level Cleared:
    When all apples are cut: level + 1, stuck knives cleared, new apples spawned.
    level_started_at = server_time + 1000ms. Throws before this are rejected.
    Apples per level formula: min(2 + 2 * level, 20).
- Game Over & Winner:
    When either player's hearts reach 0:
    THE PLAYER WITH THE HIGHER SCORE WINS! (Not the player with hearts left).
    Tied score -> is_draw: true, winner: null.
- Turns:
    Alternate after every throw (stick or clank).
    Round 1: Red throws first.
    Round 2 (Rematch): Blue throws first.


4. CLIENT -> SERVER EVENTS (iOS EMITS):
--------------------------------------------------------------------------------
Always use emitWithAck for instant responses:

1) "knife:game:join"
   Payload: { "game_id": "<UUID>" }
   Ack:     { "ok": true, "your_color": "red", "game": {...}, "players": [...] }
   * Note: Also call this to re-join after reconnecting.

2) "knife:throw"
   Payload: {
     "game_id": "<UUID>",
     "throw_number": 1,    // Next expected throw number (1, 2, 3...)
     "level": 1,           // Current level number
     "angle": 45.2         // Landing angle on log (0 to 359.9)
   }
   Success Ack: {
     "ok": true,
     "game_id": "<UUID>",
     "user_id": "<USER_ID>",
     "color": "red",
     "throw_number": 1,
     "angle": 45.2,
     "result": "stick",    // "stick" or "clank"
     "apples_cut": [0],    // Array of apple indices cut
     "points": 1,          // Points earned this throw
     "scores": { "red": 1, "blue": 0 },
     "lives": { "red": 3, "blue": 3 },
     "next_turn": "blue",  // Whose turn is next (null if game over)
     "next_throw_number": 2,
     "level_cleared": false,
     "next_level": null,   // { level, level_started_at, apples } if cleared
     "game_over": false,
     "server_time": 1795400010000
   }
   Error Ack: {
     "ok": false,
     "code": "THROW_FAILED",
     "reason": "NOT_YOUR_TURN" | "STALE_THROW" | "LEVEL_STARTING" | "INVALID_ANGLE"
   }

3) "knife:rematch:request"
   Payload: { "game_id": "<UUID>" }
   Ack:     { "ok": true }
   * Triggers "knife:rematch:requested" on opponent's screen.

4) "knife:rematch:respond"
   Payload: { "game_id": "<UUID>", "accept": true } // or false
   Ack:     { "ok": true, "game": {...}, "players": [...] } (if accepted)
            { "ok": true, "accepted": false } (if declined)

5) "knife:game:leave"
   Payload: { "game_id": "<UUID>" }
   Ack:     { "ok": true, "game_abandoned": true }

6) "knife:time"
   Payload: {}
   Ack:     { "ok": true, "server_time": 1795400005000 }


5. SERVER -> CLIENT EVENTS (iOS LISTENS TO):
--------------------------------------------------------------------------------
1) "knife:player:joined"
   Sent to: Opponent
   Payload: { "game": {...}, "players": [...] }
   Action:  Opponent has entered or reconnected.

2) "knife:game:started"
   Sent to: Both players
   Payload: { "game": {...}, "players": [...] }
   Action:  Match starts. Start log spin at game.level_started_at.

3) "knife:thrown"
   Sent to: Opponent & other devices
   Payload: Identical to the throw result object above.
   Action:  Animate knife throw, display clank or stick, update scores & hearts.

4) "knife:game:over"
   Sent to: Both players
   Payload: {
     "status": "finished",
     "winner": "red",          // "red", "blue", or null (Draw)
     "winner_user_id": "<UUID>",
     "is_draw": false,
     "reason": "SCORE" | "OPPONENT_LEFT" | "OPPONENT_DISCONNECTED",
     "scores": { "red": 8, "blue": 4 },
     "lives": { "red": 2, "blue": 0 },
     "level": 3
   }
   Action:  Display Game Over dialog and Rematch button.

5) "knife:rematch:requested"
   Sent to: Opponent
   Payload: { "user_id": "<REQUESTER_ID>" }
   Action:  Show alert: "Opponent wants a rematch! Accept? [Yes] [No]".
            Emit "knife:rematch:respond" with accept: true or false.

6) "knife:rematch:declined"
   Sent to: Requester
   Payload: { "user_id": "..." }
   Action:  Show toast: "Rematch was declined."

7) "knife:game:restarted"
   Sent to: Both players
   Payload: { "game": {...}, "players": [...] }
   Action:  Reset board to Level 1, scores = 0, lives = 3.
            Note: Blue throws first in Round 2!

8) "knife:player:disconnected"
   Sent to: Opponent
   Payload: { "user_id": "...", "timeout_ms": 60000 }
   Action:  Show banner: "Opponent disconnected. 60s to reconnect...".

9) "knife:player:left"
   Sent to: Opponent
   Payload: { "user_id": "..." }
   Action:  Opponent exited. Game awarded by forfeit.


6. ERROR CODES & REASONS:
--------------------------------------------------------------------------------
| code             | reason              | Description                           |
| :--------------- | :------------------ | :------------------------------------ |
| `THROW_FAILED`   | `NOT_YOUR_TURN`     | Threw when current_turn was opponent   |
| `THROW_FAILED`   | `STALE_THROW`       | throw_number or level mismatch         |
| `THROW_FAILED`   | `LEVEL_STARTING`    | Threw before level_started_at pause    |
| `THROW_FAILED`   | `INVALID_ANGLE`     | Angle outside 0..360 or not a number   |
| `THROW_FAILED`   | `GAME_NOT_ACTIVE`   | Game not in playing state              |
| `REMATCH_FAILED` | `GAME_NOT_FINISHED` | Asked rematch while still playing      |
| `REMATCH_FAILED` | `OPPONENT_LEFT`     | Asked rematch after opponent left      |
| `NOT_IN_GAME`    | `NOT_IN_GAME`       | Did not join game first                |
================================================================================
```
