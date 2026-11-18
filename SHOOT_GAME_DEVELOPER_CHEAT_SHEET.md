# Shoot Game iOS Developer Cheat Sheet & API Spec

A complete, production-ready integration guide for the **Shoot Game** ("Shoot your best shot" 2-player target shooting game). Covers REST lobby endpoints, Socket.IO real-time events, screen coordinates, Catmull-Rom/Hermite crosshair animation math, ring scoring, turn lifecycle, rematch rules, error codes, and drop-in Swift models and SocketManager templates.

---

## 1. Connection & Namespaces

- **Production Base URL:** `https://drawing-widget-backend.onrender.com`
- **Socket.IO Endpoint:** `https://drawing-widget-backend.onrender.com/v1`
- **Namespace:** `/v1` (with fallback on `/`)
- **Transport:** WebSocket preferred (`.forceWebsockets(true)`)
- **Event Prefix:** `shoot:`
- **REST Endpoints:** `/api/v1/shoot` (also aliases `/api/shoot`)

### Socket Connection Handshake
Pass user identity in `auth` or `connectParams` and extra headers:
```swift
let url = URL(string: "https://drawing-widget-backend.onrender.com/v1")!
let manager = SocketManager(socketURL: url, config: [
    .log(false),
    .forceWebsockets(true),
    .connectParams([
        "userId": userId,           // String (e.g. "user_alice_123")
        "devicetype": "ios",        // String ("ios" or "android")
        "name": displayName,        // String (e.g. "Alice")
        "profileImage": avatarName  // String (e.g. "A7")
    ]),
    .extraHeaders([
        "x-user-id": userId,
        "devicetype": "ios"
    ])
])
let socket = manager.defaultSocket
```

---

## 2. Coordinate System & Crosshair Path Math

### 2.1 Target Sizing & Anchors
- The target asset image is rendered at **$280 \times 280\text{ pt}$** ($1104 \times 1104\text{ px}$).
- Anchor point $(0, 0)$ is the **dead center** of the target.
- $+x$ = **right**, $+y$ = **down** (standard screen coordinates).
- Target crosshair bounds: $\text{horizontal travel} = \pm 139\text{ pt}$, $\text{vertical travel} = \pm 168\text{ pt}$.

```
                 -y (up, -168 pt)
                         |
  -x (left, -139 pt) ----+---- +x (right, +139 pt)
                         |
                 +y (down, +168 pt)
```

### 2.2 Server Path & Interpolation Formula
The server generates an array of $100$ normalized waypoint spots in $[-1.0, 1.0]$. The phone drives smooth motion between spots using **Hermite smoothstep interpolation**:

$$\text{progress} = \text{turn.path\_progress} + \frac{\max(0, \text{elapsed\_ms})}{\text{turn.segment\_ms}}$$
$$\text{step} = \lfloor\text{progress}\rfloor, \quad t = \text{progress} - \text{step}, \quad \text{ease} = t^2 \times (3 - 2t)$$
$$x = (\text{from}.x + (\text{to}.x - \text{from}.x) \times \text{ease}) \times 139$$
$$y = (\text{from}.y + (\text{to}.y - \text{from}.y) \times \text{ease}) \times 168$$

### 2.3 Swift Crosshair Calculation
```swift
struct Point2D: Codable {
    let x: Double
    let y: Double
}

func crosshairPosition(
    path: [Point2D],
    pathProgress: Double,
    segmentMs: Double,
    elapsedMs: Double,
    rangeX: Double = 139.0,
    rangeY: Double = 168.0
) -> CGPoint {
    guard !path.isEmpty, segmentMs > 0 else { return .zero }
    let progress = pathProgress + max(0.0, elapsedMs) / segmentMs
    let step = Int(floor(progress))
    let t = progress - floor(progress)
    let ease = t * t * (3.0 - 2.0 * t) // Hermite smoothstep
    
    let from = path[step % path.count]
    let to = path[(step + 1) % path.count]
    
    let normX = from.x + (to.x - from.x) * ease
    let normY = from.y + (to.y - from.y) * ease
    
    return CGPoint(x: normX * rangeX, y: normY * rangeY)
}
```

---

## 3. Game Configuration & Speed Progression

| Config Key | Value | Description |
| :--- | :--- | :--- |
| `max_shots` | `5` | Shots per player per match ($10$ total turns) |
| `path_length` | `100` | Spots on crosshair path (seamless loop) |
| `range_x` | `139` | Crosshair horizontal travel ($\pm 139\text{ pt}$) |
| `range_y` | `168` | Crosshair vertical travel ($\pm 168\text{ pt}$) |
| `target_size` | `280` | Render size of target graphic in points |
| `base_segment_ms`| `800` | Speed in Shot Round 1 ($800\text{ ms}$ per spot) |
| `segment_step_ms`| `50` | Accelerates $50\text{ ms}$ each round |
| `result_pause_ms`| `1200`| Pause after normal shot ($1.2\text{ s}$) before next turn |
| `bullseye_pause_ms`| `1600`| Pause after a 50pt Bullseye ($1.6\text{ s}$) |
| `start_delay_ms` | `1000`| Countdown delay ($1\text{ s}$) before crosshair starts moving |
| `early_slack_ms` | `250` | Client clock-sync tolerance |
| `late_slack_ms`  | `1500`| Network latency grace window |
| `turn_timeout_ms`| `15000`| $15\text{ s}$ auto-fire timer if player does not tap |

### Speed Acceleration by Shot Round
| Shot Numbers | Shot Round | Shooter | `segment_ms` | Speed Feeling |
| :---: | :---: | :---: | :---: | :--- |
| **1 & 2** | Round 1 | Blue, then Red | **$800\text{ ms}$** | Gentle warm-up |
| **3 & 4** | Round 2 | Blue, then Red | **$750\text{ ms}$** | Moderate |
| **5 & 6** | Round 3 | Blue, then Red | **$700\text{ ms}$** | Fast |
| **7 & 8** | Round 4 | Blue, then Red | **$650\text{ ms}$** | Very Fast |
| **9 & 10** | Round 5 | Blue, then Red | **$600\text{ ms}$** | Maximum Speed |

---

## 4. Ring Scoring Breakdown

The server computes points strictly from the crosshair coordinates at tap time:

| Points | Ring Area | Visual Color | Pause After Shot |
| :---: | :--- | :--- | :---: |
| **50** | **Bullseye** Center Dot | Gold / Yellow | **$1600\text{ ms}$** |
| **40** | Inner Ring | Deep Orange | $1200\text{ ms}$ |
| **30** | Mid Ring | Electric Blue | $1200\text{ ms}$ |
| **20** | Outer Ring | Dark Grey / Slate | $1200\text{ ms}$ |
| **10** | Perimeter Ring | Clean White | $1200\text{ ms}$ |
| **0** | Miss | Outside Target Area | $1200\text{ ms}$ |

---

## 5. REST Lobby Endpoints

All responses follow standard `{ success: Bool, message: String, data: T }`.

### 5.1 Create Game (Host - Blue)
- **POST** `/api/v1/shoot`
- **Headers:** `x-user-id: <USER_ID>`, `devicetype: ios`, `Content-Type: application/json`
- **Body:**
```json
{
  "name": "Alice",
  "profile_image": "A7"
}
```
- **Response Data:**
```json
{
  "color": "blue",
  "game": {
    "id": "6f1c42e8-9b88-4c91-...",
    "code": "7Q6D4M",
    "host_id": "user_alice_123",
    "status": "waiting",
    "round": 1,
    "first_turn": "blue",
    "current_turn": null,
    "shot_number": 0,
    "shot_round": 1,
    "scores": { "blue": 0, "red": 0 },
    "shots_left": { "blue": 5, "red": 5 },
    "shots": [],
    "turn": null,
    "server_time": 1794995468869,
    "winner": null,
    "winner_user_id": null,
    "is_draw": false,
    "end_reason": null,
    "config": { ... }
  },
  "players": [
    {
      "user_id": "user_alice_123",
      "color": "blue",
      "name": "Alice",
      "profile_image": "A7",
      "left_at": null
    }
  ]
}
```

### 5.2 Join Game (Guest - Red)
- **POST** `/api/v1/shoot/join`
- **Headers:** `x-user-id: <USER_ID>`, `devicetype: ios`, `Content-Type: application/json`
- **Body:**
```json
{
  "code": "7Q6D4M",
  "name": "Bob",
  "profile_image": "B3"
}
```
- **Response Data:**
```json
{
  "color": "red",
  "game": {
    "id": "6f1c42e8-9b88-4c91-...",
    "code": "7Q6D4M",
    "status": "playing",
    "round": 1,
    "first_turn": "blue",
    "current_turn": "blue",
    "shot_number": 0,
    "shot_round": 1,
    "scores": { "blue": 0, "red": 0 },
    "shots_left": { "blue": 5, "red": 5 },
    "turn": {
      "color": "blue",
      "shot_number": 1,
      "started_at": 1794995477402,
      "deadline_at": 1794995492402,
      "path_progress": 0,
      "segment_ms": 800,
      "path": [ { "x": 0.0519, "y": -0.2117 }, ... 100 items ]
    },
    "server_time": 1794995476406
  },
  "players": [ ... ]
}
```

### 5.3 Fetch Game by ID or Code
- **GET** `/api/v1/shoot/:id`
- **GET** `/api/v1/shoot/code/:code`
Returns `{ success: true, data: { game, players } }`. Joining again with the same `user_id` returns the current game state without error.

---

## 6. Client ➔ Server Socket Events (Emit with Ack)

Always emit with acknowledgment to capture immediate feedback and errors:

### 6.1 Clock Synchronization: `shoot:time`
Call immediately on connection to calculate network RTT and clock offset:
```swift
let sendTime = Date().timeIntervalSince1970 * 1000
socket.emitWithAck("shoot:time", [:]).timingOut(after: 2) { data in
    guard let res = data.first as? [String: Any],
          let serverTime = res["server_time"] as? Double else { return }
    let now = Date().timeIntervalSince1970 * 1000
    let rtt = now - sendTime
    self.clockOffsetMs = serverTime - (sendTime + rtt / 2.0)
}
```

### 6.2 Join Game Room: `shoot:game:join`
Emitted upon entering the game view or after app reconnection:
```swift
socket.emitWithAck("shoot:game:join", ["game_id": gameId]).timingOut(after: 5) { data in
    guard let res = data.first as? [String: Any], res["ok"] as? Bool == true else { return }
    let myColor = res["your_color"] as? String // "blue" or "red"
    let game = res["game"] as? [String: Any]
    let players = res["players"] as? [[String: Any]]
}
```

### 6.3 Fire Shot: `shoot:fire`
Emitted when the player taps the screen during their turn:
```swift
let serverNow = (Date().timeIntervalSince1970 * 1000) + clockOffsetMs
let elapsedMs = max(0, Int(serverNow - turnStartedAtMs))

let payload: [String: Any] = [
    "game_id": gameId,
    "shot_number": nextShotNumber, // 1 through 10
    "elapsed_ms": elapsedMs        // milliseconds since turn.started_at
]

socket.emitWithAck("shoot:fire", payload).timingOut(after: 4) { data in
    guard let res = data.first as? [String: Any] else { return }
    if res["ok"] as? Bool == true {
        let shot = res["shot"] as? [String: Any]
        let points = shot?["points"] as? Int // 50, 40, 30, 20, 10, or 0
        let x = shot?["x"] as? Double
        let y = shot?["y"] as? Double
        let isGameOver = res["game_over"] as? Bool ?? false
        let nextTurn = res["next_turn"] as? [String: Any]
    } else {
        let reason = res["reason"] as? String // "NOT_YOUR_TURN", "STALE_SHOT", "TURN_STARTING"
    }
}
```

### 6.4 Rematch Request: `shoot:rematch:request`
```swift
socket.emitWithAck("shoot:rematch:request", ["game_id": gameId]).timingOut(after: 5) { _ in }
```

### 6.5 Rematch Response: `shoot:rematch:respond`
```swift
socket.emitWithAck("shoot:rematch:respond", [
    "game_id": gameId,
    "accept": true // true to accept, false to decline
]).timingOut(after: 5) { _ in }
```

### 6.6 Leave Game: `shoot:game:leave`
```swift
socket.emitWithAck("shoot:game:leave", ["game_id": gameId]).timingOut(after: 5) { _ in }
```

---

## 7. Server ➔ Client Socket Events (Listeners)

| Event Name | Sent To | Purpose | Key Payload Fields |
| :--- | :--- | :--- | :--- |
| `shoot:player:joined` | Opponent | Player entered lobby/socket | `{ user_id, game, players }` |
| `shoot:game:started` | **Both** | Match begins (once/round) | `{ game, players }` |
| `shoot:fired` | **Both** | Shot landed & scored | `{ shot, scores, shots_left, next_turn, shot_round, game_over }` |
| `shoot:game:over` | **Both** | Match finished / forfeit | `{ status, winner, winner_user_id, is_draw, reason, scores }` |
| `shoot:rematch:requested` | Opponent | Friend requested rematch | `{ user_id }` |
| `shoot:rematch:declined` | Asker | Rematch was declined | `{ user_id }` |
| `shoot:game:restarted` | **Both** | New round begins | `{ game, players }` (Round + 1, Red starts) |
| `shoot:player:disconnected` | Opponent | Opponent disconnected | `{ user_id, timeout_ms: 60000 }` |
| `shoot:player:left` | Opponent | Opponent left / timed out | `{ user_id }` |

### Detailed Event Payloads

#### `shoot:fired` Event Payload
```json
{
  "game_id": "6f1c42e8-9b88-4c91-...",
  "shot": {
    "shot_number": 1,
    "color": "blue",
    "user_id": "user_alice_123",
    "elapsed_ms": 1150,
    "adjusted": false,
    "auto": false,
    "x": 24.3182,
    "y": -12.4491,
    "path_progress": 1.4375,
    "points": 40
  },
  "scores": { "blue": 40, "red": 0 },
  "shots_left": { "blue": 4, "red": 5 },
  "next_turn": {
    "color": "red",
    "shot_number": 2,
    "started_at": 1794995482000,
    "deadline_at": 1794995497000,
    "path_progress": 1.4375,
    "segment_ms": 800,
    "path": [ ... ]
  },
  "shot_round": 1,
  "game_over": false,
  "winner": null,
  "server_time": 1794995480800
}
```

#### `shoot:game:over` Event Payload
```json
{
  "status": "finished",
  "winner": "blue",
  "winner_user_id": "user_alice_123",
  "is_draw": false,
  "reason": "SCORE",
  "scores": { "blue": 180, "red": 140 }
}
```
*Note:* If a player forfeits or times out after 60s, `status` is `"abandoned"`, `reason` is `"OPPONENT_LEFT"` or `"OPPONENT_DISCONNECTED"`, and the remaining player is declared the winner regardless of score.

---

## 8. Error Codes & Reasons Table

All rejected socket calls return `{ ok: false, error: String, code: String, reason: String }` and emit `app:error`.

| Error `code` | Error `reason` | Cause | Recommended Client Action |
| :--- | :--- | :--- | :--- |
| `SHOT_FAILED` | `NOT_YOUR_TURN` | Player tapped on opponent's turn | Ignore tap, light haptic feedback |
| `SHOT_FAILED` | `STALE_SHOT` | Shot number mismatch / duplicate tap | Discard tap, resync with latest turn |
| `SHOT_FAILED` | `TURN_STARTING` | Tapped during result pause or countdown | Show crosshair waiting state |
| `SHOT_FAILED` | `INVALID_TIME` | `elapsed_ms` negative, non-number, or future | Trigger `shoot:time` re-sync |
| `SHOT_FAILED` | `GAME_NOT_ACTIVE` | Match has ended or not yet started | Disable tap gesture |
| `REMATCH_FAILED` | `GAME_NOT_FINISHED` | Rematch requested before game over | Keep rematch button disabled |
| `REMATCH_FAILED` | `NO_REMATCH_REQUEST` | Responding when no request is open | Reset dialog state |
| `REMATCH_FAILED` | `CANNOT_ACCEPT_OWN_REMATCH` | Requester attempted to accept self | Show "Waiting for opponent..." |
| `REMATCH_FAILED` | `OPPONENT_LEFT` | Opponent abandoned or disconnected | Return to Lobby screen |
| `NOT_IN_GAME` | `NOT_IN_GAME` | Player has left or was never in game | Route to Main Menu |

---

## 9. Drop-In Swift Data Models (`Codable`)

```swift
import Foundation

// MARK: - Game Response Wrapper
struct ShootAPIResponse<T: Codable>: Codable {
    let success: Bool
    let message: String
    let data: T
}

// MARK: - Game Object
struct ShootGame: Codable {
    let id: String
    let code: String
    let hostId: String?
    let status: String            // "waiting", "playing", "finished", "abandoned"
    let round: Int
    let firstTurn: String?        // "blue" in round 1, "red" in round 2
    let currentTurn: String?      // "blue" or "red"
    let shotNumber: Int
    let shotRound: Int
    let scores: ShootScores
    let shotsLeft: ShootShotsLeft
    let shots: [ShootShot]?
    let turn: ShootTurn?
    let serverTime: Double
    let winner: String?           // "blue", "red", or nil
    let winnerUserId: String?
    let isDraw: Bool
    let endReason: String?        // "SCORE", "OPPONENT_LEFT", "OPPONENT_DISCONNECTED"
    let config: ShootConfig?

    enum CodingKeys: String, CodingKey {
        case id, code, status, round, scores, shots, turn, winner, config
        case hostId = "host_id"
        case firstTurn = "first_turn"
        case currentTurn = "current_turn"
        case shotNumber = "shot_number"
        case shotRound = "shot_round"
        case shotsLeft = "shots_left"
        case serverTime = "server_time"
        case winnerUserId = "winner_user_id"
        case isDraw = "is_draw"
        case endReason = "end_reason"
    }
}

// MARK: - Turn
struct ShootTurn: Codable {
    let color: String
    let shotNumber: Int
    let startedAt: Double
    let deadlineAt: Double?
    let pathProgress: Double
    let segmentMs: Double
    let path: [Point2D]

    enum CodingKeys: String, CodingKey {
        case color, path
        case shotNumber = "shot_number"
        case startedAt = "started_at"
        case deadlineAt = "deadline_at"
        case pathProgress = "path_progress"
        case segmentMs = "segment_ms"
    }
}

// MARK: - Shot
struct ShootShot: Codable {
    let shotNumber: Int
    let color: String
    let userId: String
    let elapsedMs: Double?
    let adjusted: Bool?
    let auto: Bool?
    let x: Double
    let y: Double
    let points: Int

    enum CodingKeys: String, CodingKey {
        case color, x, y, points, adjusted, auto
        case shotNumber = "shot_number"
        case userId = "user_id"
        case elapsedMs = "elapsed_ms"
    }
}

// MARK: - Players, Scores & Config
struct ShootPlayer: Codable {
    let userId: String
    let color: String
    let name: String
    let profileImage: String?
    let leftAt: String?

    enum CodingKeys: String, CodingKey {
        case color, name
        case userId = "user_id"
        case profileImage = "profile_image"
        case leftAt = "left_at"
    }
}

struct ShootScores: Codable {
    let blue: Int
    let red: Int
}

struct ShootShotsLeft: Codable {
    let blue: Int
    let red: Int
}

struct ShootConfig: Codable {
    let rangeX: Double
    let rangeY: Double
    let maxShots: Int
    let pathLength: Int
    let targetSize: Double
    let lateSlackMs: Double
    let earlySlackMs: Double
    let startDelayMs: Double
    let baseSegmentMs: Double
    let resultPauseMs: Double
    let segmentStepMs: Double
    let turnTimeoutMs: Double
    let bullseyePauseMs: Double

    enum CodingKeys: String, CodingKey {
        case rangeX = "range_x"
        case rangeY = "range_y"
        case maxShots = "max_shots"
        case pathLength = "path_length"
        case targetSize = "target_size"
        case lateSlackMs = "late_slack_ms"
        case earlySlackMs = "early_slack_ms"
        case startDelayMs = "start_delay_ms"
        case baseSegmentMs = "base_segment_ms"
        case resultPauseMs = "result_pause_ms"
        case segmentStepMs = "segment_step_ms"
        case turnTimeoutMs = "turn_timeout_ms"
        case bullseyePauseMs = "bullseye_pause_ms"
    }
}
```

---

## 10. Complete Swift `ShootGameSocketManager`

```swift
import Foundation
import SocketIO

// MARK: - Notification Names
extension Notification.Name {
    static let shootPlayerJoined      = Notification.Name("shootPlayerJoined")
    static let shootGameStarted       = Notification.Name("shootGameStarted")
    static let shootFired             = Notification.Name("shootFired")
    static let shootGameOver          = Notification.Name("shootGameOver")
    static let shootRematchRequested  = Notification.Name("shootRematchRequested")
    static let shootRematchDeclined   = Notification.Name("shootRematchDeclined")
    static let shootGameRestarted     = Notification.Name("shootGameRestarted")
    static let shootPlayerDisconnected = Notification.Name("shootPlayerDisconnected")
    static let shootPlayerLeft         = Notification.Name("shootPlayerLeft")
}

final class ShootGameSocketManager {
    static let shared = ShootGameSocketManager()
    
    private var manager: SocketManager?
    private var socket: SocketIOClient?
    
    private(set) var clockOffsetMs: Double = 0
    private(set) var myColor: String = "blue"
    private(set) var currentGameId: String?
    
    private init() {}
    
    // MARK: - Connect
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
            ]),
            .extraHeaders([
                "x-user-id": userId,
                "devicetype": "ios"
            ])
        ])
        socket = manager?.defaultSocket
        setupListeners()
        socket?.connect()
    }
    
    func disconnect() {
        socket?.disconnect()
    }
    
    // MARK: - Setup Listeners
    private func setupListeners() {
        guard let socket = socket else { return }
        
        socket.on(clientEvent: .connect) { [weak self] _, _ in
            self?.syncClock()
        }
        
        socket.on("shoot:player:joined") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .shootPlayerJoined, object: dict)
        }
        
        socket.on("shoot:game:started") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .shootGameStarted, object: dict)
        }
        
        socket.on("shoot:fired") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .shootFired, object: dict)
        }
        
        socket.on("shoot:game:over") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .shootGameOver, object: dict)
        }
        
        socket.on("shoot:rematch:requested") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .shootRematchRequested, object: dict)
        }
        
        socket.on("shoot:rematch:declined") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .shootRematchDeclined, object: dict)
        }
        
        socket.on("shoot:game:restarted") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .shootGameRestarted, object: dict)
        }
        
        socket.on("shoot:player:disconnected") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .shootPlayerDisconnected, object: dict)
        }
        
        socket.on("shoot:player:left") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .shootPlayerLeft, object: dict)
        }
    }
    
    // MARK: - Actions
    func syncClock() {
        let sendTime = Date().timeIntervalSince1970 * 1000
        socket?.emitWithAck("shoot:time", [:]).timingOut(after: 2) { [weak self] data in
            guard let res = data.first as? [String: Any],
                  let serverTime = res["server_time"] as? Double else { return }
            let now = Date().timeIntervalSince1970 * 1000
            let rtt = now - sendTime
            self?.clockOffsetMs = serverTime - (sendTime + rtt / 2.0)
        }
    }
    
    func joinGameRoom(gameId: String, completion: @escaping (Bool, [String: Any]?) -> Void) {
        self.currentGameId = gameId
        socket?.emitWithAck("shoot:game:join", ["game_id": gameId]).timingOut(after: 5) { [weak self] data in
            guard let res = data.first as? [String: Any] else {
                completion(false, nil)
                return
            }
            if let color = res["your_color"] as? String {
                self?.myColor = color
            }
            let isOk = res["ok"] as? Bool ?? false
            completion(isOk, res)
        }
    }
    
    func fireShot(
        gameId: String,
        shotNumber: Int,
        turnStartedAtMs: Double,
        completion: @escaping (Bool, [String: Any]?) -> Void
    ) {
        let serverNow = (Date().timeIntervalSince1970 * 1000) + clockOffsetMs
        let elapsed = max(0, Int(serverNow - turnStartedAtMs))
        
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
    
    func requestRematch(gameId: String) {
        socket?.emitWithAck("shoot:rematch:request", ["game_id": gameId]).timingOut(after: 5) { _ in }
    }
    
    func respondRematch(gameId: String, accept: Bool) {
        socket?.emitWithAck("shoot:rematch:respond", [
            "game_id": gameId,
            "accept": accept
        ]).timingOut(after: 5) { _ in }
    }
    
    func leaveGame(gameId: String) {
        socket?.emitWithAck("shoot:game:leave", ["game_id": gameId]).timingOut(after: 5) { _ in }
    }
}
```

---

## 11. iOS Frontend Integration Checklist

- [ ] **Lobby View:**
  - [ ] Show 6-character uppercase join code.
  - [ ] Listen for `shoot:player:joined` &rarr; dismiss "Waiting for opponent" spinner when friend enters.
- [ ] **Match Start:**
  - [ ] Receive `shoot:game:started` &rarr; display 1-second countdown ("3.. 2.. 1.. SHOOT!").
  - [ ] Set crosshair starting position at `turn.started_at` ($1\text{ s}$ in future).
- [ ] **Crosshair Rendering:**
  - [ ] Attach `CADisplayLink` (60/120 FPS).
  - [ ] Evaluate `crosshairPosition(...)` using Hermite smoothstep at current `elapsedMs = serverNow - turn.started_at`.
  - [ ] Center crosshair at `(center.x + x, center.y + y)`.
- [ ] **Player Tap Gesture:**
  - [ ] If `current_turn != myColor`: Ignore tap or trigger soft failure haptic (`UINotificationFeedbackGenerator(.warning)`).
  - [ ] If `serverNow < turn.started_at`: Ignore tap (crosshair is frozen in delay).
  - [ ] If valid: Emit `shoot:fire` with `elapsed_ms = serverNow - turn.started_at`.
- [ ] **Shot Result Presentation:**
  - [ ] Freeze crosshair at returned `(shot.x, shot.y)`.
  - [ ] Draw bullet hole sprite at `(shot.x, shot.y)`.
  - [ ] Animate floating score label: `+50` (Gold), `+40` (Orange), `+30` (Blue), `+20` (Grey), `+10` (White), or `MISS` (Red).
  - [ ] Play sound / heavy impact haptic for 50 Bullseye (`UIImpactFeedbackGenerator(.heavy)`).
  - [ ] Update header scoreboard (`scores.blue`, `scores.red`) and decrement remaining bullet icons (`shots_left`).
- [ ] **Next Turn Transition:**
  - [ ] Keep bullet hole visible.
  - [ ] Wait until `next_turn.started_at` ($1.2\text{ s}$ or $1.6\text{ s}$ after shot).
  - [ ] Crosshair starts moving smoothly again along `next_turn.path` with updated `segment_ms`.
- [ ] **Game Over & Rematch:**
  - [ ] On `shoot:game:over`: Present Game Over modal with Winner avatar and final scores.
  - [ ] Tapping "Rematch": Emit `shoot:rematch:request`.
  - [ ] Opponent sees pop-up: "Alice wants a rematch! Accept?" [Yes] [No].
  - [ ] On `shoot:game:restarted`: Wipe bullet holes from board, reset scores to 0, reset bullets to 5, and start Round 2 with Red shooting first.
- [ ] **Reconnection & Disconnect Grace:**
  - [ ] On `shoot:player:disconnected`: Show banner "Opponent disconnected. 60s reconnection window...".
  - [ ] If opponent rejoins: Banner disappears seamlessly.
  - [ ] If 60s expires: `shoot:game:over` arrives with `status: "abandoned"`, `reason: "OPPONENT_DISCONNECTED"`, awarding you victory.
