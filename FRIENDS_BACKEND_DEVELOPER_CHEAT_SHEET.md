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
| `invite:received` | Friend | `{ invite_id, game, room_code, from: { friend }, expires_at }` | Display incoming invitation alert with 60s timer. |
| `invite:accepted` | Host | `{ invite_id, by_user_id, game, room_code }` | Host waiting modal dismisses; opponent joins lobby. |
| `invite:declined` | Host | `{ invite_id, by_user_id }` | Show toast: *"Friend declined the invitation."* |
| `invite:cancelled`| Both | `{ invite_id, reason }` | Reason: `"GAME_FULL"`, `"HOST_LEFT"`, `"REPLACED"`, `"CANCELLED"`. |
| `invite:expired`  | Both | `{ invite_id }` | Auto-dismisses invite modal after 60s timeout. |

#### Invite Error Codes (`ack { ok: false, code, error }`):

| Error `code` | Meaning |
| :--- | :--- |
| `NOT_FRIENDS` | `to_user_id` is not on the sender's friend list. |
| `GAME_NOT_FOUND` | No game of that type found with `room_code`. |
| `NOT_HOST` | Sender is not the game's host. |
| `GAME_FULL` | Game already has two players or is no longer `waiting`. |
| `FRIEND_OFFLINE` | Friend has no connected socket. |
| `FRIEND_BUSY` | Friend's status is `in_game`. |
| `INVITE_ENDED` | Responding to an invite that was cancelled, expired, or already used. |

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

