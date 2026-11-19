# Friends & Game Invites Backend Spec & iOS Developer Cheat Sheet

A complete, production-ready integration guide for the **Friends System & Real-Time Game Invites**. Eliminates manual 6-character room codes by allowing users to add friends permanently via an 8-character friend code and send instant one-tap game invitations.

---

## 1. Overview & Core Architecture

* **No Login/Password:** Every user account is identified by their persistent lowercase UUID (`x-user-id`), securely stored in the iOS Keychain.
* **Permanent Friend Code:** 8 uppercase characters (from Crockford Base32 alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, excluding ambiguous `0`, `O`, `1`, `I`).
* **Format:** Stored and transmitted without dashes (e.g. `P9VA6NBH`), but displayed in UI with a center dash (`P9VA-6NBH`).
* **Instant Mutual Add:** Adding someone by code automatically establishes a mutual friendship for both players.
* **Real-Time Presence:** Friends dynamically show `online` (app foregrounded), `in_game` (playing a match with game identifier), or `offline` (disconnected $>5\text{ s}$).
* **Seamless Game Invites:** A host in any game lobby (Shoot, Knife, Tic-Tac-Toe) sends a one-tap invite to an online friend. Accepting auto-navigates both players into the match without typing a room code.

---

## 2. Base URLs & Namespaces

* **REST Base URL:** `https://drawing-widget-backend.onrender.com` *(or `http://localhost:3000` for local dev)*
* **Socket.IO Endpoint:** `https://drawing-widget-backend.onrender.com/v1`
* **Namespace:** `/v1` (with fallback on `/`)
* **Transport:** WebSocket preferred (`.forceWebsockets(true)`)

---

## 3. Required HTTP Headers

Sent on every REST request:

| Header | Example | Description |
| :--- | :--- | :--- |
| `x-user-id` | `8f3c1a2e-4b7e-491a-96e2-30219488a011` | Lowercase UUID account identifier (persisted in iOS Keychain). |
| `x-device-id`| `4b7e9d10-38cf-4a11-a89c-0c5092a58dac` | Apple's `identifierForVendor` (used for device auditing and support). |
| `devicetype` | `ios` | Client platform (`ios` or `android`). |

---

## 4. Friend Object Schema

Returned across all friend endpoints and socket broadcasts:
```json
{
  "user_id": "8f3c1a2e-0002-4000-8000-000000000002",
  "name": "Sunny Otter",
  "profile_image": "A4",
  "friend_code": "KT7MPQ2X",
  "is_online": true,
  "status": "online",
  "game": null
}
```
* `is_online`: Boolean flag (`status !== "offline"`).
* `status`: `"online"` (app open), `"in_game"` (playing), or `"offline"`.
* `game`: When `status === "in_game"`, contains `"shoot"`, `"knife"`, or `"tictactoe"`.

---

## 5. REST API Endpoints

All responses follow the standard envelope:
```json
{
  "success": true,
  "message": "OK",
  "data": { ... }
}
```

### 5.1 Register / Upsert User
Called on every app launch and whenever the Friends tab opens. Returns existing friend code or generates a permanent new one on first launch.
* **Method & Path:** `POST /api/v1/users/register` (also accepts `/api/v1/users`)
* **Headers:** `x-user-id`, `x-device-id`, `devicetype`, `Content-Type: application/json`
* **Request Body:**
  ```json
  {
    "device_id": "4b7e9d10-38cf-4a11-a89c-0c5092a58dac",
    "name": "Bumblebee",
    "profile_image": "A1",
    "platform": "ios"
  }
  ```
* **Response Data:**
  ```json
  {
    "user_id": "8f3c1a2e-4b7e-491a-96e2-30219488a011",
    "friend_code": "P9VA6NBH"
  }
  ```

---

### 5.2 Lookup Player by Friend Code
Preview player profile before confirming "Add Friend". Accepts codes with or without dash, case-insensitive (e.g. `p9va-6nbh` or `P9VA6NBH`).
* **Method & Path:** `GET /api/v1/users/by-code/:code`
* **Headers:** `x-user-id`, `devicetype: ios`
* **Rate Limit:** 20 lookups per minute per user.
* **Response Data:**
  ```json
  {
    "user_id": "8f3c1a2e-0002-4000-8000-000000000002",
    "name": "Sunny Otter",
    "profile_image": "A4",
    "friend_code": "KT7MPQ2X",
    "is_online": true,
    "status": "online",
    "game": null
  }
  ```

---

### 5.3 List Friends
Returns all mutual friends, newest first (`ORDER BY created_at DESC`), enriched with live presence.
* **Method & Path:** `GET /api/v1/friends`
* **Headers:** `x-user-id`, `devicetype: ios`
* **Response Data:**
  ```json
  {
    "friends": [
      {
        "user_id": "8f3c1a2e-0002-4000-8000-000000000002",
        "name": "Sunny Otter",
        "profile_image": "A4",
        "friend_code": "KT7MPQ2X",
        "is_online": true,
        "status": "online",
        "game": null
      }
    ]
  }
  ```

---

### 5.4 Add Friend
Instantly creates a mutual friendship. Sends real-time `friend:added` socket event to the friend.
* **Method & Path:** `POST /api/v1/friends`
* **Headers:** `x-user-id`, `devicetype: ios`, `Content-Type: application/json`
* **Request Body:**
  ```json
  {
    "friend_code": "KT7M-PQ2X"
  }
  ```
* **Response Data:**
  ```json
  {
    "friend": {
      "user_id": "8f3c1a2e-0002-4000-8000-000000000002",
      "name": "Sunny Otter",
      "profile_image": "A4",
      "friend_code": "KT7MPQ2X",
      "is_online": true,
      "status": "online",
      "game": null
    }
  }
  ```

---

### 5.5 Remove Friend
Removes the friendship pair mutually. Sends real-time `friend:removed` socket event to the friend.
* **Method & Path:** `DELETE /api/v1/friends/:user_id`
* **Headers:** `x-user-id`, `devicetype: ios`
* **Response Data:**
  ```json
  {
    "success": true,
    "message": "OK",
    "data": null
  }
  ```
  *(Removing someone who is not a friend still succeeds idempotently).*

---

## 6. REST Error Responses (`success: false`)

The iOS app displays `message` directly in alert dialogs and toasts:

| Error Case | HTTP Status | Error `message` |
| :--- | :---: | :--- |
| **Code not found** | `404` | `"No player found with code ABCD-2345"` |
| **Own code** | `400` | `"That's your own friend code. Share it with a friend instead."` |
| **Already friends** | `409` | `"You're already friends with Sunny Otter"` |
| **Bad format** | `400` | `"Friend codes are 8 letters and numbers"` |
| **Friend limit reached** | `409` | `"You can have up to 200 friends"` |
| **Too many lookups** | `429` | `"Too many tries. Wait a minute and try again."` |
| **Missing user header** | `401` | `"Missing or invalid user id header (x-user-id)"` |

---

## 7. Socket.IO Real-Time Events

The app maintains a single persistent socket on `/v1` while foregrounded. Upon connection, the socket automatically joins a personal room `user:<user_id>`.

### 7.1 Presence Synchronization

| Event | Direction | Payload | Description |
| :--- | :---: | :--- | :--- |
| `friends:presence` | Server $\to$ App | `{ friends: [{ user_id, status, game }] }` | Emitted to connecting user immediately on connect with all friends' presence. |
| `friend:presence` | Server $\to$ App | `{ user_id, status, game }` | Emitted when a friend's status changes (`online`, `in_game`, `offline`). |
| `friend:added` | Server $\to$ App | `{ friend: { ... } }` | Emitted to a user when someone adds them with their code. |
| `friend:removed` | Server $\to$ App | `{ user_id }` | Emitted to a user when a friend removes them. |

---

### 7.2 Game Invites Flow

A host in an online lobby invites a friend. The friend accepts, then joins via the game's existing REST join endpoint using `room_code` (identical to typing the code).

```
Host (Lobby)                              Server                            Friend (Home/Friends)
    │                                       │                                        │
    │─── invite:send {to_user_id, game, ───▶│                                        │
    │                 room_code}            │                                        │
    │◀── ack {ok: true, invite_id} ─────────│─── invite:received {invite_id, game, ─▶│ (Show Invite
    │                                       │                     from, room_code}   │  Alert: 60s)
    │                                       │                                        │
    │                                       │◀── invite:respond {invite_id, ─────────│ (Taps Accept)
    │                                       │                    accept: true}       │
    │◀── invite:accepted {invite_id, ───────│─── ack {ok: true} ────────────────────▶│
    │                     by_user_id}       │                                        │
    │                                       │◀── POST /api/v1/:game/join ────────────│ (Joins Room)
    │                                       │    {code: room_code}                   │
    ▼                                       ▼                                        ▼
                   BOTH PLAYERS ARE IN THE MATCH AUTOMATICALLY!
```

#### Client $\to$ Server Socket Calls:

1. **Send Game Invite (`invite:send`):**
   ```swift
   socket.emitWithAck("invite:send", [
       "to_user_id": friendUserId,
       "game": "shoot", // "shoot" | "knife" | "tictactoe"
       "room_code": "7Q6D4M"
   ]).timingOut(after: 5) { data in
       guard let res = data.first as? [String: Any], res["ok"] as? Bool == true else { return }
       let inviteId = res["invite_id"] as? String
       let expiresAt = res["expires_at"] as? Double
   }
   ```

2. **Respond to Invite (`invite:respond`):**
   ```swift
   socket.emitWithAck("invite:respond", [
       "invite_id": inviteId,
       "accept": true // or false
   ]).timingOut(after: 5) { data in
       guard let res = data.first as? [String: Any], res["ok"] as? Bool == true else { return }
       // If accepted, immediately call POST /api/v1/:game/join with room_code!
   }
   ```

3. **Cancel Invite (`invite:cancel`):**
   ```swift
   socket.emitWithAck("invite:cancel", [
       "invite_id": inviteId
   ]).timingOut(after: 5) { _ in }
   ```

#### Server $\to$ Client Invite Broadcasts:

| Event Name | Sent To | Payload | Client Action |
| :--- | :---: | :--- | :--- |
| `invite:received` | Friend | `{ invite_id, game, room_code, from: { friend }, expires_at }` | Display incoming invitation banner/modal with 60s countdown. |
| `invite:accepted` | Host | `{ invite_id, by_user_id, game, room_code }` | Host waiting modal transitions to *"Sunny is joining..."*; friend joins. |
| `invite:declined` | Host | `{ invite_id, by_user_id }` | Show toast: *"Friend declined the invitation."* Lobby stays open. |
| `invite:cancelled`| Both | `{ invite_id, reason }` | Reason: `"GAME_FULL"`, `"HOST_LEFT"`, `"REPLACED"`, `"CANCELLED"`. Hides banner. |
| `invite:expired`  | Both | `{ invite_id }` | Auto-dismisses invite modal after 60s timeout. |

---

### 7.3 Checks on `invite:send` (Executed in Order)

The server runs these 7 checks in strict order. The first failure is acked as `{ ok: false, code, error }` and also emitted as `app:error`. The iOS app displays `error` directly to the player:

| # | Check Description | Fail `code` | Exact Player-Facing `error` |
| :-: | :--- | :--- | :--- |
| **1** | Sender and `to_user_id` are mutual friends | `NOT_FRIENDS` | `"You can only invite friends"` |
| **2** | Target game with `room_code` exists | `GAME_NOT_FOUND` | `"That game has ended. Start a new one."` |
| **3** | Sender is the game's `host_id` | `NOT_HOST` | `"Only the host can invite"` |
| **4** | Game status is `waiting` with 1 player | `GAME_FULL` | `"Your game already has two players"` |
| **5** | Friend has an active connected socket | `FRIEND_OFFLINE` | `"<Friend Name> is offline"` *(e.g. "Brave Fox is offline")* |
| **6** | Friend is not currently in a game | `FRIEND_BUSY` | `"<Friend Name> is in another game"` *(e.g. "Brave Fox is in another game")* |
| **7** | Host has another open invite | *(no error)* | Server sends `invite:cancelled { reason: "REPLACED" }` for the old invite, then sends the new one. |

> **Note on `invite:respond` with `accept: true`:** If the game is already full or no longer `waiting`, the server acks `{ ok: false, code: "INVITE_ENDED" }` so the app displays *"That game has already started."*

---

### 7.4 Open Invite Cancellation Matrix

An open invite automatically ends whenever the game state changes under it:

| Trigger Event | Where in Code Today | Reason Broadcast (`invite:cancelled`) |
| :--- | :--- | :--- |
| **Someone else joins via code / QR** | REST `POST /:game/join` turns game `playing` | `GAME_FULL` |
| **Host leaves waiting lobby** | `<game>:game:leave` while `waiting` | `HOST_LEFT` |
| **Host drops and 60 s grace runs out** | Disconnect timeout $\to$ game marked `abandoned` | `HOST_LEFT` |
| **Host sends a new invite** | `invite:send` while one is already pending | `REPLACED` |
| **Host taps Cancel in lobby** | `invite:cancel { invite_id }` | `CANCELLED` |
| **60 s timer expires without response** | In-memory 60 s invite timer | Emits `invite:expired { invite_id }` |

---

### 7.5 Presence Rules Across All Games (`knife`, `shoot`, `tictactoe`)

1. **App Foregrounded:** Socket connects to `/v1` $\to$ automatically joins `user:<user_id>`. Server sends `friends:presence` initial sync, and friends receive `friend:presence { status: "online", game: null }`.
2. **Game Goes Playing:** When the guest joins (via REST join $\to$ socket join), both players' statuses update to `in_game` with `game: "knife"`, `"shoot"`, or `"tictactoe"`.
3. **Normal Game Over (`SCORE` / `WIN` / `DRAW`):** Both players **stay `in_game`** while they sit on the results screen deciding on a rematch.
4. **Leaving Match Screen:** When a player leaves the match or results screen (`<game>:game:leave`), their status restores to `online`. The opponent restores to `online` once they exit their screen.
5. **App Backgrounded / Disconnected:** Status transitions to `offline` after the 5-second disconnect grace window (`DISCONNECT_GRACE_MS = 5000`).
6. **Rematches:** Rematches (`knife:rematch:*`, `shoot:rematch:*`, `ttt:restart`) operate within the existing match room and need no invite. After leaving, "New game" creates a fresh code for a new `invite:send`.

---

### 7.6 Game-Specific Join & Start Flow

| Game | Host Lobby Setup | Friend Join Flow | Socket Start Event |
| :--- | :--- | :--- | :--- |
| **Knife Hit** | `POST /api/v1/knife` $\to$ host is `red`, status `waiting` | Friend accepts $\to$ `POST /api/v1/knife/join { code }` $\to$ `knife:game:join` | `knife:game:started` sent to both with `level_started_at` & `server_time`. |
| **Target Shoot** | `POST /api/v1/shoot` $\to$ host is `blue`, status `waiting` | Friend accepts $\to$ `POST /api/v1/shoot/join { code }` (guest is `red`) $\to$ `shoot:game:join` | `shoot:game:started` sent to both with real synchronized first turn & crosshair path. |
| **Tic Tac Toe** | `POST /api/v1/tictactoe` $\to$ host is `X`, status `waiting` | Friend accepts $\to$ `POST /api/v1/tictactoe/join { code }` (guest is `O`) $\to$ `ttt:game:join` | `ttt:player:joined` notifies host; board opens on both devices. |

---

## 8. Complete Drop-in Swift Socket & Friends Manager

```swift
import Foundation
import SocketIO

// MARK: - Notification Names
extension Notification.Name {
    static let friendPresenceChanged = Notification.Name("friendPresenceChanged")
    static let friendsPresenceLoaded = Notification.Name("friendsPresenceLoaded")
    static let friendAdded           = Notification.Name("friendAdded")
    static let friendRemoved         = Notification.Name("friendRemoved")
    static let gameInviteReceived    = Notification.Name("gameInviteReceived")
    static let gameInviteAccepted    = Notification.Name("gameInviteAccepted")
    static let gameInviteDeclined    = Notification.Name("gameInviteDeclined")
    static let gameInviteCancelled   = Notification.Name("gameInviteCancelled")
    static let gameInviteExpired     = Notification.Name("gameInviteExpired")
}

// MARK: - Models
struct FriendUser: Codable, Identifiable {
    var id: String { user_id }
    let user_id: String
    let name: String
    let profile_image: String
    let friend_code: String
    let is_online: Bool
    let status: String       // "online", "in_game", "offline"
    let game: String?        // "shoot", "knife", "tictactoe", or nil
}

struct GameInvite: Codable {
    let invite_id: String
    let game: String
    let room_code: String
    let from: FriendUser
    let expires_at: Double
}

final class FriendsSocketManager {
    static let shared = FriendsSocketManager()
    
    private var manager: SocketManager?
    private var socket: SocketIOClient?
    
    private init() {}
    
    func connect(userId: String, deviceId: String) {
        let url = URL(string: "https://drawing-widget-backend.onrender.com/v1")!
        manager = SocketManager(socketURL: url, config: [
            .log(false),
            .forceWebsockets(true),
            .connectParams([
                "userId": userId,
                "devicetype": "ios",
                "deviceId": deviceId
            ]),
            .extraHeaders([
                "x-user-id": userId,
                "x-device-id": deviceId,
                "devicetype": "ios"
            ])
        ])
        socket = manager?.defaultSocket
        setupListeners()
        socket?.connect()
    }
    
    private func setupListeners() {
        guard let socket = socket else { return }
        
        socket.on("friends:presence") { data, _ in
            guard let dict = data.first as? [String: Any],
                  let friends = dict["friends"] as? [[String: Any]] else { return }
            NotificationCenter.default.post(name: .friendsPresenceLoaded, object: friends)
        }
        
        socket.on("friend:presence") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .friendPresenceChanged, object: dict)
        }
        
        socket.on("friend:added") { data, _ in
            guard let dict = data.first as? [String: Any],
                  let friend = dict["friend"] as? [String: Any] else { return }
            NotificationCenter.default.post(name: .friendAdded, object: friend)
        }
        
        socket.on("friend:removed") { data, _ in
            guard let dict = data.first as? [String: Any],
                  let userId = dict["user_id"] as? String else { return }
            NotificationCenter.default.post(name: .friendRemoved, object: userId)
        }
        
        socket.on("invite:received") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .gameInviteReceived, object: dict)
        }
        
        socket.on("invite:accepted") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .gameInviteAccepted, object: dict)
        }
        
        socket.on("invite:declined") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .gameInviteDeclined, object: dict)
        }
        
        socket.on("invite:cancelled") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .gameInviteCancelled, object: dict)
        }
        
        socket.on("invite:expired") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .gameInviteExpired, object: dict)
        }
    }
    
    func sendInvite(toUserId: String, game: String, roomCode: String, completion: @escaping (Bool, String?) -> Void) {
        socket?.emitWithAck("invite:send", [
            "to_user_id": toUserId,
            "game": game,
            "room_code": roomCode
        ]).timingOut(after: 5) { data in
            guard let res = data.first as? [String: Any] else {
                completion(false, "Network timeout")
                return
            }
            if res["ok"] as? Bool == true {
                let inviteId = res["invite_id"] as? String
                completion(true, inviteId)
            } else {
                let error = res["error"] as? String ?? res["code"] as? String ?? "Failed"
                completion(false, error)
            }
        }
    }
    
    func respondInvite(inviteId: String, accept: Bool, completion: @escaping (Bool) -> Void) {
        socket?.emitWithAck("invite:respond", [
            "invite_id": inviteId,
            "accept": accept
        ]).timingOut(after: 5) { data in
            guard let res = data.first as? [String: Any] else {
                completion(false)
                return
            }
            completion(res["ok"] as? Bool ?? false)
        }
    }
    
    func cancelInvite(inviteId: String) {
        socket?.emitWithAck("invite:cancel", ["invite_id": inviteId]).timingOut(after: 5) { _ in }
    }
}
```

