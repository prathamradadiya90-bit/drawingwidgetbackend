# Shoot Game iOS Developer Cheat Sheet & API Spec

A concise, complete integration guide for the **Shoot Game** ("Shoot your best shot" 2-player online multiplayer target game). Covers REST lobby endpoints, Socket.IO real-time events, coordinates, ring scoring, turn lifecycle, rematch rules, error handling, and a drop-in Swift SocketManager template.

---

## 1. Connection & Namespaces

- **Base URL:** `https://drawing-widget-backend.onrender.com`
- **Socket.IO URL:** `https://drawing-widget-backend.onrender.com/v1`
- **Namespace:** `/v1` (with fallback on `/`)
- **Transport:** WebSocket preferred (`.forceWebsockets(true)`)
- **Event Prefix:** `shoot:`
- **REST Base:** `/api/v1/shoot`

### Socket Connection Handshake
Pass user identity in `auth` or `connectParams` and headers:
```swift
manager = SocketManager(socketURL: url, config: [
    .log(false),
    .forceWebsockets(true),
    .connectParams([
        "userId": userId,           // String (UUID)
        "devicetype": "ios",        // String ("ios" or "android")
        "name": displayName,        // String (e.g. "Alice")
        "profileImage": avatarName  // String (e.g. "A7")
    ])
])
```

---

## 2. Coordinates & Game Config

All positions are in **target points**:
- The target picture is drawn **$280 \times 280\text{ pt}$** ($1104 \times 1104\text{ px}$).
- $(0, 0)$ is the **center** of the target picture.
- $+x$ = **right**, $+y$ = **down** (standard screen coordinates).
- Path spots are stored normalized in $[-1, 1]$ and scaled by `range_x` ($139\text{ pt}$) and `range_y` ($168\text{ pt}$).

| Config Key | Value | Description |
| :--- | :--- | :--- |
| `max_shots` | `5` | Shots per player per game ($10$ total per match) |
| `path_length` | `100` | Spots on the crosshair path (loops seamlessly) |
| `range_x` | `139` | Crosshair horizontal travel from center ($\pm 139\text{ pt}$) |
| `range_y` | `168` | Crosshair vertical travel from center ($\pm 168\text{ pt}$) |
| `target_size` | `280` | Size the target image is drawn at |
| `base_segment_ms` | `800` | Milliseconds per spot in Shot Round 1 |
| `segment_step_ms` | `50` | Gets $50\text{ ms}$ faster each shot round ($800, 750, 700, 650, 600\text{ ms}$) |
| `result_pause_ms` | `1200` | Pause after normal shot ($1.2\text{ s}$) before next turn starts |
| `bullseye_pause_ms` | `1600` | Pause after a 50 bullseye ($1.6\text{ s}$) |
| `start_delay_ms` | `1000` | Crosshair starts moving $1\text{ s}$ after round start / rematch |
| `late_slack_ms` | `1500` | Allowed network latency before clamping tap time |
| `early_slack_ms` | `250` | Allowed clock-sync jitter |
| `turn_timeout_ms` | `15000` | $15\text{ s}$ auto-fire if shooter never taps |

---

## 3. Ring Scoring Math

Points awarded based on measured ring boundaries:
- **50 Points:** Yellow Bullseye center dot
- **40 Points:** Inner orange ring
- **30 Points:** Blue ring
- **20 Points:** Dark grey ring
- **10 Points:** Outer white ring
- **0 Points:** Target miss

The server calculates the exact position of the crosshair at `elapsed_ms` and scores the ring:
```
crosshairAt(path, turn, elapsed_ms) -> x, y, path_progress
scoreShot(x, y) -> points (50, 40, 30, 20, 10, or 0)
```

---

## 4. REST Lobby Endpoints

All responses are wrapped in `{ success: true, message: "...", data: {...} }`.

### 4.1 Create Game (Host - Blue)
- **Endpoint:** `POST /api/v1/shoot`
- **Headers:** `x-user-id: <USER_ID>`, `devicetype: ios`, `Content-Type: application/json`
- **Body:**
  ```json
  {
    "name": "Alice",
    "profile_image": "A7"
  }
  ```
- **Response `data`:**
  ```json
  {
    "color": "blue",
    "game": {
      "id": "9f1c...",
      "code": "K7QP2M",
      "status": "waiting",
      "round": 1,
      "scores": { "blue": 0, "red": 0 },
      "shots_left": { "blue": 5, "red": 5 }
    },
    "players": [{ "user_id": "...", "color": "blue", "name": "Alice", "profile_image": "A7" }]
  }
  ```

### 4.2 Join Game (Guest - Red)
- **Endpoint:** `POST /api/v1/shoot/join`
- **Headers:** `x-user-id: <USER_ID>`, `devicetype: ios`, `Content-Type: application/json`
- **Body:**
  ```json
  {
    "code": "K7QP2M",
    "name": "Bob",
    "profile_image": "B3"
  }
  ```
- **Response `data`:**
  ```json
  {
    "color": "red",
    "game": {
      "id": "9f1c...",
      "status": "playing",
      "round": 1,
      "first_turn": "blue",
      "current_turn": "blue",
      "turn": { ... }
    },
    "players": [...]
  }
  ```
- *Note:* The Host waiting in the socket room immediately receives `shoot:player:joined`.

### 4.3 Get Game Details
- `GET /api/v1/shoot/:id`
- `GET /api/v1/shoot/code/:code`

---

## 5. Client ➔ Server Socket Events (iOS Emits)

Always emit with acknowledgment (`emitWithAck`).

### 5.1 Clock Synchronization: `shoot:time`
Call at start of match to compute server clock offset:
```swift
socket.emitWithAck("shoot:time", [:]).timingOut(after: 2) { data in
    guard let res = data.first as? [String: Any],
          let serverTime = res["server_time"] as? Double else { return }
    let latency = (Date().timeIntervalSince1970 * 1000 - clientSendTime) / 2
    let clockOffset = serverTime - (clientSendTime + latency)
}
```

### 5.2 Join Socket Room: `shoot:game:join`
Emitted on view appear or reconnect:
```swift
socket.emitWithAck("shoot:game:join", ["game_id": gameId]).timingOut(after: 5) { data in
    guard let res = data.first as? [String: Any], res["ok"] as? Bool == true else { return }
    let myColor = res["your_color"] as? String // "blue" or "red"
    let game = res["game"] as? [String: Any]
    let players = res["players"] as? [[String: Any]]
}
```

### 5.3 Fire Shot: `shoot:fire`
Emitted when the player taps the screen:
```swift
let payload: [String: Any] = [
    "game_id": gameId,
    "shot_number": nextShotNumber, // Int (1, 2, ... 10)
    "elapsed_ms": elapsedMilliseconds // Double/Int (ms since turn.started_at in server time)
]

socket.emitWithAck("shoot:fire", payload).timingOut(after: 5) { data in
    guard let res = data.first as? [String: Any] else { return }
    if res["ok"] as? Bool == true {
        let shot = res["shot"] as? [String: Any]
        let points = shot?["points"] as? Int        // 50, 40, 30, 20, 10, or 0
        let x = shot?["x"] as? Double
        let y = shot?["y"] as? Double
        let isGameOver = res["game_over"] as? Bool ?? false
        let nextTurn = res["next_turn"] as? [String: Any]
    } else {
        let reason = res["reason"] as? String // e.g. "NOT_YOUR_TURN", "STALE_SHOT", "TURN_STARTING"
    }
}
```

### 5.4 Rematch Request: `shoot:rematch:request`
```swift
socket.emitWithAck("shoot:rematch:request", ["game_id": gameId]).timingOut(after: 5) { data in
    // Server acknowledged; opponent receives "shoot:rematch:requested"
}
```

### 5.5 Rematch Response: `shoot:rematch:respond`
```swift
socket.emitWithAck("shoot:rematch:respond", [
    "game_id": gameId,
    "accept": true // or false
]).timingOut(after: 5) { data in
    // If accepted: BOTH players receive "shoot:game:restarted"
}
```

### 5.6 Leave Game: `shoot:game:leave`
```swift
socket.emitWithAck("shoot:game:leave", ["game_id": gameId]).timingOut(after: 5) { _ in }
```

---

## 6. Server ➔ Client Socket Events (iOS Listens To)

### 6.1 `shoot:player:joined`
Fired when guest joins over REST or reconnects via socket:
```swift
socket.on("shoot:player:joined") { data, _ in
    guard let res = data.first as? [String: Any],
          let game = res["game"] as? [String: Any],
          let players = res["players"] as? [[String: Any]] else { return }
    // Update lobby / dismiss reconnection banners
}
```

### 6.2 `shoot:game:started`
Fired strictly **once per round** when both players are connected:
```swift
socket.on("shoot:game:started") { data, _ in
    guard let res = data.first as? [String: Any],
          let game = res["game"] as? [String: Any] else { return }
    // Start initial 1s countdown; crosshair moves from turn.started_at
}
```

### 6.3 `shoot:fired`
Broadcast to opponent (and shooter on auto-fire) after an accepted shot:
```swift
socket.on("shoot:fired") { data, _ in
    guard let res = data.first as? [String: Any],
          let shot = res["shot"] as? [String: Any] else { return }
    let x = shot["x"] as? Double
    let y = shot["y"] as? Double
    let points = shot["points"] as? Int
    let auto = shot["auto"] as? Bool ?? false
    
    // 1. Freeze crosshair at (x, y)
    // 2. Animate bullet hole and score popup (+50, +40, etc.)
    // 3. Update scoreboard
    // 4. Wait for next_turn.started_at to begin next shot
}
```

### 6.4 `shoot:game:over`
Fired after the 10th shot or upon forfeit:
```swift
socket.on("shoot:game:over") { data, _ in
    guard let res = data.first as? [String: Any] else { return }
    let winner = res["winner"] as? String // "blue", "red", or nil (Draw)
    let reason = res["reason"] as? String // "SCORE", "OPPONENT_LEFT", "OPPONENT_DISCONNECTED"
    let scores = res["scores"] as? [String: Int]
    
    // Present Game Over dialog with Winner and Rematch button
}
```

### 6.5 `shoot:rematch:requested`
```swift
socket.on("shoot:rematch:requested") { data, _ in
    // Show alert: "Opponent wants a rematch! Accept?" [Accept] [Decline]
}
```

### 6.6 `shoot:rematch:declined`
```swift
socket.on("shoot:rematch:declined") { data, _ in
    // Toast: "Rematch was declined."
}
```

### 6.7 `shoot:game:restarted`
Broadcast to **both players** when rematch begins:
```swift
socket.on("shoot:game:restarted") { data, _ in
    guard let res = data.first as? [String: Any],
          let game = res["game"] as? [String: Any] else { return }
    // 1. Reset target bullet holes
    // 2. Scores = 0, shots_left = 5
    // 3. Note: Red shoots first in Round 2!
}
```

### 6.8 `shoot:player:disconnected`
```swift
socket.on("shoot:player:disconnected") { data, _ in
    // Show banner: "Opponent disconnected. 60s reconnection grace period..."
}
```

### 6.9 `shoot:player:left`
```swift
socket.on("shoot:player:left") { data, _ in
    // Opponent left; game awarded to remaining player
}
```

---

## 7. Error Codes Reference

| Error `code` | Error `reason` | Cause | Recommended Action |
| :--- | :--- | :--- | :--- |
| `SHOT_FAILED` | `NOT_YOUR_TURN` | Player tapped on friend's turn | Subtle haptic feedback, ignore tap |
| `SHOT_FAILED` | `STALE_SHOT` | Duplicate tap or outdated shot sequence | Re-sync next shot number |
| `SHOT_FAILED` | `TURN_STARTING` | Tap occurred during the result pause | Wait for `turn.started_at` |
| `SHOT_FAILED` | `INVALID_TIME` | `elapsed_ms` missing, negative, or future | Check device clock sync |
| `SHOT_FAILED` | `GAME_NOT_ACTIVE` | Match finished or not started | Ignore tap |
| `REMATCH_FAILED` | `NO_REMATCH_REQUEST` | Respond without active request | Keep rematch button enabled |
| `REMATCH_FAILED` | `CANNOT_ACCEPT_OWN_REMATCH` | Requester attempted to accept self | Wait for opponent response |
| `REMATCH_FAILED` | `OPPONENT_LEFT` | Friend left or timed out | Show "Return to Lobby" |
| `NOT_IN_GAME` | `NOT_IN_GAME` | Player has left or was not seated | Return to Main Menu |

---

## 8. Complete Swift SocketManager Template

```swift
import Foundation
import SocketIO

final class ShootGameSocketManager {
    static let shared = ShootGameSocketManager()
    
    private var manager: SocketManager?
    private var socket: SocketIOClient?
    
    private(set) var clockOffsetMs: Double = 0
    
    func connect(userId: String, name: String, avatar: String) {
        let url = URL(string: "https://drawing-widget-backend.onrender.com/v1")!
        manager = SocketManager(socketURL: url, config: [
            .log(false),
            .forceWebsockets(true),
            .connectParams([
                "userId": userId,
                "devicetype": "ios",
                "name": name,
                "profileImage": avatar
            ])
        ])
        socket = manager?.defaultSocket
        setupListeners()
        socket?.connect()
    }
    
    private func setupListeners() {
        guard let socket = socket else { return }
        
        socket.on(clientEvent: .connect) { [weak self] _, _ in
            self?.syncClock()
        }
        
        socket.on("shoot:player:joined") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .onShootPlayerJoined, object: dict)
        }
        
        socket.on("shoot:game:started") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .onShootGameStarted, object: dict)
        }
        
        socket.on("shoot:fired") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .onShootFired, object: dict)
        }
        
        socket.on("shoot:game:over") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .onShootGameOver, object: dict)
        }
        
        socket.on("shoot:rematch:requested") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .onShootRematchRequested, object: dict)
        }
        
        socket.on("shoot:rematch:declined") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .onShootRematchDeclined, object: dict)
        }
        
        socket.on("shoot:game:restarted") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .onShootGameRestarted, object: dict)
        }
        
        socket.on("shoot:player:disconnected") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .onShootPlayerDisconnected, object: dict)
        }
        
        socket.on("shoot:player:left") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .onShootPlayerLeft, object: dict)
        }
    }
    
    func syncClock() {
        let sendTime = Date().timeIntervalSince1970 * 1000
        socket?.emitWithAck("shoot:time", [:]).timingOut(after: 2) { [weak self] data in
            guard let res = data.first as? [String: Any],
                  let serverTime = res["server_time"] as? Double else { return }
            let now = Date().timeIntervalSince1970 * 1000
            let rtt = now - sendTime
            self?.clockOffsetMs = serverTime - (sendTime + rtt / 2)
        }
    }
    
    func sendFire(gameId: String, shotNumber: Int, startedAtMs: Double, completion: @escaping (Bool, [String: Any]?) -> Void) {
        let serverNow = (Date().timeIntervalSince1970 * 1000) + clockOffsetMs
        let elapsed = max(0, Int(serverNow - startedAtMs))
        
        let payload: [String: Any] = [
            "game_id": gameId,
            "shot_number": shotNumber,
            "elapsed_ms": elapsed
        ]
        
        socket?.emitWithAck("shoot:fire", payload).timingOut(after: 4) { data in
            guard let res = data.first as? [String: Any] else {
                completion(false, nil)
                return
            }
            let isOk = res["ok"] as? Bool ?? false
            completion(isOk, res)
        }
    }
}
```
