# Friends v2 Frontend Developer Cheat Sheet
**For iOS & Frontend Engineers** · *Drawing Widget & Mini-Games*  
**Backend Environment:** `https://drawing-widget-backend.onrender.com`  
**Socket.IO Endpoint:** `https://drawing-widget-backend.onrender.com/v1`

---

## 1. What Changed in v2 (Executive Summary)

| Feature | Friends v1 | Friends v2 |
| :--- | :--- | :--- |
| **Authentication** | Only `x-user-id` header (easily spoofed) | Secret **`auth_token`** (32+ bytes) generated on register, saved in Keychain, sent on **all** REST & Socket calls. |
| **Add Friend** | Instant mutual add | Asynchronous **Friend Request** (Send $\to$ Accept/Decline/Cancel/7-day Expiry). |
| **Match Pop-up Add** | Not available | Tap "Add as friend?" after any match $\to$ `POST /api/v1/friend-requests` by `user_id`. |
| **Notifications Inbox** | None | **Bell on Home Screen** showing pending requests + missed invites (last 7 days). |
| **Missed Game Invites** | Lost when away | Auto-stored as a `missed_invite` if friend is offline or doesn't answer within 60s. |
| **Deduplication** | None | Repeat invites within 30 mins refresh timestamp instead of cluttering the list. |

---

## 2. Authentication & Device Token

### 2.1 The Flow
1. On **first app launch**, call `POST /api/v1/users/register`.
2. The server generates a unique **`auth_token`** and returns it in `data.auth_token`.
3. Save **both** `user_id` and `auth_token` into the **iOS Keychain** (survives app reinstalls).
4. Send `x-auth-token` on **every subsequent REST call** and `auth: { token }` on **every Socket.IO connect**.
5. On subsequent app launches, calling `register` with `x-auth-token` will succeed and return `{ user_id, friend_code }` without returning a new token.

### 2.2 Mandatory HTTP Headers (Every REST Call)
```http
x-user-id: 8f3c1a2e-4b7e-491a-96e2-30219488a011
x-auth-token: r2Jf0uY0w8lq6H1pZb9oS3cXyVQeT4nKmA7dGzW5iE
x-device-id: 4b7e9d10-38cf-4a11-a89c-0c5092a58dac
devicetype: ios
Content-Type: application/json
```

### 2.3 Socket.IO Handshake Authentication
Pass both `userId` and `token` in the handshake `auth` (or `query`):
```swift
let manager = SocketManager(socketURL: URL(string: "https://drawing-widget-backend.onrender.com/v1")!, config: [
    .log(false),
    .forceWebsockets(true),
    .connectParams([
        "userId": currentUserId,
        "token": currentAuthToken
    ])
])
```

### 2.4 Auth Errors
* **HTTP 401:** `"Your session is no longer valid. Reinstall the app or contact support."`
  * Action: Prompt user to restart/reinstall app (token lost or corrupted).
* **Socket Connect Error:** `Unauthorized: invalid token`
  * Action: Socket connection rejected due to missing or invalid token.

---

## 3. REST API Reference

Standard response envelope: `{ "success": true, "message": "OK", "data": { ... } }`.  
Display error `message` directly in an alert or toast.

---

### 3.1 Register User (`POST /api/v1/users/register`)
Call on every launch.
* **Request:**
  ```json
  POST /api/v1/users/register
  Headers: x-user-id, [x-auth-token if saved], x-device-id, devicetype: ios
  Body:
  {
    "name": "Sunny Otter",
    "profile_image": "A4",
    "platform": "ios"
  }
  ```
* **First Launch Response (Save `auth_token` to Keychain!):**
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
      "user_id": "8f3c1a2e-4b7e-491a-96e2-30219488a011",
      "friend_code": "P9VA6NBH",
      "auth_token": "r2Jf0uY0w8lq6H1pZb9oS3cXyVQeT4nKmA7dGzW5iE"
    }
  }
  ```

---

### 3.2 Send Friend Request (`POST /api/v1/friend-requests`)

#### Case A: From Add Friend Sheet (by 8-character Code)
Dashes and lowercase are automatically handled (`kt7m-pq2x` = `KT7MPQ2X`).
```json
POST /api/v1/friend-requests
Body:
{
  "friend_code": "KT7M-PQ2X"
}
```

#### Case B: From Post-Match "Add as friend?" Pop-up (by User ID)
Only allowed if the two players played a match together in the last 24 hours.
```json
POST /api/v1/friend-requests
Body:
{
  "user_id": "8f3c1a2e-0002-4000-8000-000000000002",
  "game": "shoot"
}
```

#### Responses:
* **Normal Request Created (201 Created):**
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
      "request": {
        "request_id": "0b7e3c1a-6f2d-4a8e-9b51-2c7d4e9f1a30",
        "from": {
          "user_id": "8f3c1a2e-...",
          "name": "Sunny Otter",
          "profile_image": "A4",
          "friend_code": "KT7MPQ2X"
        },
        "to": {
          "user_id": "17cbe1d9-...",
          "name": "Brave Fox",
          "profile_image": "A15",
          "friend_code": "U6YXKDWQ"
        },
        "source": "code",
        "game": null,
        "created_at": "2026-11-19T10:15:00.000Z",
        "expires_at": "2026-11-26T10:15:00.000Z"
      }
    }
  }
  ```
* **Auto-Accept (200 OK):**  
  *If the other person ALREADY sent you a request, sending yours accepts theirs instantly!*
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
      "friend": {
        "user_id": "17cbe1d9-...",
        "name": "Brave Fox",
        "profile_image": "A15",
        "friend_code": "U6YXKDWQ",
        "is_online": true,
        "status": "online",
        "game": null
      },
      "auto_accepted": true
    }
  }
  ```

#### Error Table for `POST /api/v1/friend-requests`:
| Code | Error Message | Reason |
| :--- | :--- | :--- |
| `400` | `"Friend codes are 8 letters and numbers"` | Invalid format / characters. |
| `404` | `"No player found with code ABCD-2345"` / `"Player not found"` | Code or user ID doesn't exist. |
| `400` | `"That's your own friend code. Share it with a friend instead."` | Trying to add self. |
| `409` | `"You're already friends with <Name>"` | Already friends. |
| `403` | `"You can only add players you just played with"` | Added by user_id without shared match in 24h. |
| `409` | `"You already sent <Name> a request"` | Request already pending. |
| `409` | `"You can have up to 200 friends"` / `"<Name> can't add more friends"` | 200 friend limit reached. |
| `429` | `"You can send <Name> another request later"` | Target declined your request $<24\text{h}$ ago. |
| `429` | `"Too many requests. Wait a bit and try again."` | Exceeded 30 requests/hour. |

---

### 3.3 List Open Requests (`GET /api/v1/friend-requests`)
Returns pending and unexpired requests. Call this to show badges or open requests tab.
* **Path:** `GET /api/v1/friend-requests`
* **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
      "incoming": [
        {
          "request_id": "0b7e3c1a-...",
          "from": { "user_id": "...", "name": "Brave Fox", "profile_image": "A15", "friend_code": "U6YXKDWQ" },
          "to": { "user_id": "...", "name": "Sunny Otter", "profile_image": "A4", "friend_code": "KT7MPQ2X" },
          "source": "code",
          "game": null,
          "created_at": "2026-11-19T10:15:00.000Z",
          "expires_at": "2026-11-26T10:15:00.000Z"
        }
      ],
      "outgoing": []
    }
  }
  ```

---

### 3.4 Accept Request (`POST /api/v1/friend-requests/:request_id/accept`)
*Receiver only.* Establishes mutual friendship immediately.
* **Path:** `POST /api/v1/friend-requests/:request_id/accept`
* **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
      "friend": {
        "user_id": "8f3c1a2e-...",
        "name": "Alice",
        "profile_image": "A1",
        "friend_code": "ABCD2345",
        "is_online": true,
        "status": "online",
        "game": null
      }
    }
  }
  ```
* **Sender gets socket:** `friend:request:accepted` `{ request_id, friend }`.

---

### 3.5 Decline Request (`POST /api/v1/friend-requests/:request_id/decline`)
*Receiver only.*
* **Path:** `POST /api/v1/friend-requests/:request_id/decline`
* **Response (200 OK):** `{ "success": true, "message": "OK", "data": null }`
* **Sender gets socket:** `friend:request:ended` `{ request_id, reason: "DECLINED" }`.

---

### 3.6 Cancel Request (`DELETE /api/v1/friend-requests/:request_id`)
*Sender only.*
* **Path:** `DELETE /api/v1/friend-requests/:request_id`
* **Response (200 OK):** `{ "success": true, "message": "OK", "data": null }`
* **Receiver gets socket:** `friend:request:ended` `{ request_id, reason: "CANCELLED" }`.

---

### 3.7 Notifications Inbox (`GET /api/v1/notifications`)
Call on every launch and return from background to populate the Home bell. Shows items from the last 7 days.
* **Path:** `GET /api/v1/notifications`
* **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
      "notifications": [
        {
          "notification_id": "5d1f0e4b-...",
          "type": "missed_invite",
          "created_at": "2026-11-19T10:15:00.000Z",
          "invite": {
            "from": {
              "user_id": "8f3c1a2e-...",
              "name": "Sunny Otter",
              "profile_image": "A4",
              "friend_code": "KT7MPQ2X"
            },
            "game": "knife",
            "reason": "OFFLINE"
          }
        },
        {
          "notification_id": "6a2e8c1b-...",
          "type": "friend_request",
          "created_at": "2026-11-19T09:40:00.000Z",
          "request": {
            "request_id": "0b7e3c1a-...",
            "from": { "user_id": "...", "name": "Brave Fox", "profile_image": "A15", "friend_code": "U6YXKDWQ" },
            "to": { "user_id": "...", "name": "Sunny Otter", "profile_image": "A4", "friend_code": "KT7MPQ2X" },
            "source": "match",
            "game": "shoot",
            "created_at": "2026-11-19T09:40:00.000Z",
            "expires_at": "2026-11-26T09:40:00.000Z"
          }
        }
      ]
    }
  }
  ```
* **Missed Invite `reason` values:**
  * `"OFFLINE"`: Friend was offline when host tapped invite.
  * `"NO_ANSWER"`: Friend received invite but 60-second timer timed out.
* **"Invite Back" Button on Missed Invite:**
  * Tap "Invite Back" $\to$ opens game lobby for that game $\to$ emits `invite:send` to the person who invited them.

---

### 3.8 Acknowledge / Dismiss Notifications (`POST /api/v1/notifications/ack`)
Dismisses missed invite notifications. *(Note: Friend requests leave automatically when accepted/declined/cancelled).*
* **Dismiss Specific IDs:**
  ```json
  POST /api/v1/notifications/ack
  Body: { "notification_ids": ["5d1f0e4b-..."] }
  ```
* **Clear All Missed Invites:**
  ```json
  POST /api/v1/notifications/ack
  Body: { "all": true }
  ```
* **Response (200 OK):** `{ "success": true, "message": "OK", "data": { "removed": 1 } }`

---

### 3.9 List Friends (`GET /api/v1/friends`)
Returns all confirmed mutual friends with real-time status.
```json
GET /api/v1/friends
Response:
{
  "success": true,
  "message": "OK",
  "data": {
    "friends": [
      {
        "user_id": "8f3c1a2e-...",
        "name": "Sunny Otter",
        "profile_image": "A4",
        "friend_code": "KT7MPQ2X",
        "is_online": true,
        "status": "online",
        "game": null
      }
    ]
  }
}
```

---

### 3.10 Remove Friend (`DELETE /api/v1/friends/:user_id`)
Removes friendship mutually on both sides.
* **Path:** `DELETE /api/v1/friends/:user_id`
* **Response (200 OK):** `{ "success": true, "message": "OK", "data": null }`

---

## 4. Real-Time Socket Events (Server $\to$ Client)

Connect to namespace `/v1`. The server delivers events to your personal room `user:<user_id>`.

| Socket Event | Payload | UI / App Action |
| :--- | :--- | :--- |
| **`notification:new`** | `{ notification }` | Add item to bell list; increment unread badge counter. |
| **`notification:removed`** | `{ notification_id }` | Remove item from bell list; decrement badge counter. |
| **`friend:request:received`** | `{ request }` | Show top banner / in-app notification: *"Sunny Otter wants to be your friend"*. |
| **`friend:request:accepted`** | `{ request_id, friend }` | Show toast: *"Brave Fox accepted your friend request"*; add friend to Friends list. |
| **`friend:request:ended`** | `{ request_id, reason }` | Reason: `"DECLINED"`, `"CANCELLED"`, or `"EXPIRED"`. Remove pending request from list. |
| **`friend:presence`** | `{ user_id, status, game }` | Update friend row indicator (`online`, `in_game` [knife/shoot/tictactoe], `offline`). |
| **`friends:presence`** | `{ friends: [{ user_id, status, game }] }` | Sent on initial connect with state of all friends. |
| **`friend:added`** | `{ friend }` | Added as friend (instant mutual add or auto-accept). |
| **`friend:removed`** | `{ user_id }` | Other person unfriended you; remove from Friends list. |
| **`invite:received`** | `{ invite_id, game, room_code, from, expires_at }` | Show 60s Game Invite Banner: *"Sunny Otter invited you to play Knife Hit"*. |
| **`invite:accepted`** | `{ invite_id, by_user_id, game, room_code }` | Host waiting modal auto-navigates into match. |
| **`invite:declined`** | `{ invite_id, by_user_id }` | Host toast: *"Friend declined the invitation."* |
| **`invite:cancelled`** | `{ invite_id, reason }` | Dismiss invite banner. Reason: `"GAME_FULL"`, `"HOST_LEFT"`, `"REPLACED"`, `"CANCELLED"`. |
| **`invite:expired`** | `{ invite_id }` | 60s timeout expired. Dismiss invite modal. |

---

## 5. Game Invite Rules & Offline Hook

When host taps **Invite**:
```swift
socket.emitWithAck("invite:send", [
    "to_user_id": friendUserId,
    "game": "shoot", // "knife" | "shoot" | "tictactoe"
    "room_code": roomCode
]).timingOut(after: 5) { data in
    guard let response = data.first as? [String: Any] else { return }
    let ok = response["ok"] as? Bool ?? false
    if !ok {
        let code = response["code"] as? String ?? ""
        let error = response["error"] as? String ?? ""
        // If code == "FRIEND_OFFLINE":
        // error = "Brave Fox is offline. We'll let them know you invited them."
        // Show this message in toast! A missed_invite is automatically saved for them.
    }
}
```

---

## 6. Complete Drop-In Swift Helper

```swift
import Foundation
import Security
import SocketIO

// MARK: - 1. Keychain Helper
enum KeychainHelper {
    private static let service = "com.drawingwidget.auth"
    
    static func save(key: String, value: String) {
        let data = Data(value.utf8)
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
            kSecValueData: data
        ]
        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
    }
    
    static func get(key: String) -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data {
            return String(data: data, encoding: .utf8)
        }
        return nil
    }
}

// MARK: - 2. API Network Client
class FriendsAPI {
    static let shared = FriendsAPI()
    private let baseURL = "https://drawing-widget-backend.onrender.com"
    
    var userId: String {
        if let existing = KeychainHelper.get(key: "user_id") {
            return existing
        }
        let newId = UUID().uuidString.lowercased()
        KeychainHelper.save(key: "user_id", value: newId)
        return newId
    }
    
    var authToken: String? {
        return KeychainHelper.get(key: "auth_token")
    }
    
    func makeRequest(endpoint: String, method: String = "GET", body: [String: Any]? = nil, completion: @escaping ([String: Any]?, Error?) -> Void) {
        guard let url = URL(string: "\(baseURL)\(endpoint)") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(userId, forHTTPHeaderField: "x-user-id")
        if let token = authToken {
            request.setValue(token, forHTTPHeaderField: "x-auth-token")
        }
        request.setValue(UIDevice.current.identifierForVendor?.uuidString ?? "", forHTTPHeaderField: "x-device-id")
        request.setValue("ios", forHTTPHeaderField: "devicetype")
        
        if let body = body {
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        
        URLSession.shared.dataTask(with: request) { data, response, error in
            guard let data = data, error == nil,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                completion(nil, error)
                return
            }
            completion(json, nil)
        }.resume()
    }
    
    // Call on App Launch
    func registerUser(name: String, avatar: String, completion: @escaping () -> Void) {
        makeRequest(endpoint: "/api/v1/users/register", method: "POST", body: [
            "name": name,
            "profile_image": avatar,
            "platform": "ios"
        ]) { json, _ in
            if let data = json?["data"] as? [String: Any],
               let token = data["auth_token"] as? String {
                KeychainHelper.save(key: "auth_token", value: token)
            }
            completion()
        }
    }
}

// MARK: - 3. Socket.IO Setup
class FriendsSocketManager {
    static let shared = FriendsSocketManager()
    private var manager: SocketManager?
    var socket: SocketIOClient?
    
    func connect() {
        let userId = FriendsAPI.shared.userId
        let token = FriendsAPI.shared.authToken ?? ""
        
        manager = SocketManager(socketURL: URL(string: "https://drawing-widget-backend.onrender.com/v1")!, config: [
            .log(false),
            .forceWebsockets(true),
            .connectParams([
                "userId": userId,
                "token": token
            ])
        ])
        
        socket = manager?.defaultSocket
        registerHandlers()
        socket?.connect()
    }
    
    private func registerHandlers() {
        guard let socket = socket else { return }
        
        socket.on(clientEvent: .connect) { _, _ in
            print("Connected to friends socket")
        }
        
        // Incoming Friend Request Banner
        socket.on("friend:request:received") { data, _ in
            guard let dict = data.first as? [String: Any],
                  let request = dict["request"] as? [String: Any] else { return }
            NotificationCenter.default.post(name: .friendRequestReceived, object: request)
        }
        
        // Friend Request Accepted
        socket.on("friend:request:accepted") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .friendRequestAccepted, object: dict)
        }
        
        // Request Ended (Declined, Cancelled, Expired)
        socket.on("friend:request:ended") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .friendRequestEnded, object: dict)
        }
        
        // New Notification in Bell (badge++)
        socket.on("notification:new") { data, _ in
            guard let dict = data.first as? [String: Any],
                  let notif = dict["notification"] as? [String: Any] else { return }
            NotificationCenter.default.post(name: .newNotificationReceived, object: notif)
        }
        
        // Notification Removed from Bell (badge--)
        socket.on("notification:removed") { data, _ in
            guard let dict = data.first as? [String: Any],
                  let notifId = dict["notification_id"] as? String else { return }
            NotificationCenter.default.post(name: .notificationRemoved, object: notifId)
        }
        
        // Real-Time Presence Updates
        socket.on("friend:presence") { data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            NotificationCenter.default.post(name: .friendPresenceChanged, object: dict)
        }
    }
}

extension Notification.Name {
    static let friendRequestReceived   = Notification.Name("friendRequestReceived")
    static let friendRequestAccepted   = Notification.Name("friendRequestAccepted")
    static let friendRequestEnded      = Notification.Name("friendRequestEnded")
    static let newNotificationReceived = Notification.Name("newNotificationReceived")
    static let notificationRemoved     = Notification.Name("notificationRemoved")
    static let friendPresenceChanged   = Notification.Name("friendPresenceChanged")
}
```



---

## 8. Draw Together: Friend Invites & Canvas Sync (Nov 20, 2026 Spec)

### 8.1 Room Contract & Changes
* **Host Slot 1:** Creator always receives `slot_index: 1`. `room.host_id` is always returned. Guests joining via code are assigned `slot_index: 2`.
* **Acknowledge `room:leave`:** Client should emit `room:leave` with an ack callback. The app waits up to 2 seconds for `{ ok: true }` before closing the socket.
* **Dropped Member Presence:** `GET /api/v1/rooms/:id` returns `connected: true/false` on each member. Disconnected members drop out after 5s grace.
* **Shape & Emoji Persistence:** Shapes and emojis retain all their fields (`shape_type`, `coordinates`, `size`, `angle`, `emoji_id`, `stroke_id`, `fill_id`, `stroke_width`) on backfill and reload even when `stroke_data` is sent.
* **Template Fields Ignored:** `svg_resource` and `step_index` are ignored by the backend. Room create works without them.
* **Fast Strokes & Zero-Drop WebSocket:** Backend supports 30+ moves/sec with growing payloads without dropping or disconnecting (`close code 1006` resolved).
* **Token Auth on All Room Endpoints:** Provide `x-auth-token` header on all `/api/v1/rooms/*` routes and in `room:join`.

### 8.2 Swift Implementation for Draw Together Invites

```swift
// 1. Host invites a friend to Draw Together
func inviteFriendToDrawing(friendUserId: String, roomCode: String) {
    let payload: [String: Any] = [
        "to_user_id": friendUserId,
        "game": "drawing",
        "room_code": roomCode
    ]
    socket.emitWithAck("invite:send", payload).timingOut(after: 5) { data in
        guard let response = data.first as? [String: Any],
              let ok = response["ok"] as? Bool, ok else {
            let errorMsg = (data.first as? [String: Any])?["error"] as? String ?? "Failed to send invite"
            print("Invite error:", errorMsg)
            return
        }
        print("Drawing invite sent successfully, id: \(response["invite_id"] ?? "")")
    }
}

// 2. Friend responds to incoming drawing invite banner
func respondToDrawingInvite(inviteId: String, accept: Bool) {
    let payload: [String: Any] = [
        "invite_id": inviteId,
        "accept": accept
    ]
    socket.emitWithAck("invite:respond", payload).timingOut(after: 5) { data in
        guard let response = data.first as? [String: Any],
              let ok = response["ok"] as? Bool, ok else {
            let code = (data.first as? [String: Any])?["code"] as? String
            if code == "INVITE_ENDED" {
                print("That room has already closed.")
            }
            return
        }
        
        if accept, let roomCode = response["room_code"] as? String {
            // Join drawing room via standard REST join
            joinDrawingRoom(code: roomCode)
        }
    }
}

// 3. Graceful room:leave with ack
func leaveDrawingRoom(roomId: String, completion: @escaping () -> Void) {
    socket.emitWithAck("room:leave", ["room_id": roomId]).timingOut(after: 2) { _ in
        completion()
    }
}
```
