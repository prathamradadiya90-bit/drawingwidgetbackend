# Friends & Game Invites Backend Spec & iOS Developer Cheat Sheet (v2)

A complete, production-ready integration guide for **Friends v2, Notifications Inbox, Device Tokens & Real-Time Game Invites**. 

---

## 1. Overview & Core Architecture

* **No Login/Password:** User account identity is a permanent lowercase UUID (`x-user-id`) stored securely in the iOS Keychain.
* **Device Token (Auth Token - NEW in v2):** A cryptographically secure secret (32+ bytes, base64url) generated on register and stored in Keychain. Sent on all REST calls (`x-auth-token`) and socket handshakes (`auth: { token }`) to prevent identity spoofing.
* **Permanent Friend Code:** 8 uppercase characters (from Crockford Base32 alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, excluding ambiguous `0`, `O`, `1`, `I`). Transmitted without dashes (e.g. `P9VA6NBH`), formatted in UI with center dash (`P9VA-6NBH`).
* **Friend Requests (NEW in v2):** Two players become friends via asynchronous request & accept. Requests are valid for 7 days. Supports Add by Code or Add after Match (`user_id`).
* **Notification Inbox (NEW in v2):** Centralized bell inbox showing pending friend requests and missed game invites from the last 7 days.
* **Real-Time Presence:** Friends dynamically show `online` (app foregrounded), `in_game` (playing a match with game identifier), or `offline` (disconnected $>5\text{ s}$).
* **Seamless Game Invites:** Host in any game lobby (Shoot, Knife, Tic-Tac-Toe) sends a one-tap invite. If the friend is offline or misses the 60s window, a `missed_invite` notification is recorded with 30-minute deduplication.

---

## 2. Base URLs & Namespaces

* **REST Base URL:** `https://drawing-widget-backend.onrender.com` *(or `http://localhost:3000` for local dev)*
* **Socket.IO Endpoint:** `https://drawing-widget-backend.onrender.com/v1`
* **Namespace:** `/v1` (with fallback on `/`)
* **Transport:** WebSocket preferred (`.forceWebsockets(true)`)

---

## 3. Headers & Authentication

### 3.1 HTTP Headers (Sent on every REST request)

| Header | Example | Description |
| :--- | :--- | :--- |
| `x-user-id` | `8f3c1a2e-4b7e-491a-96e2-30219488a011` | Lowercase UUID account identifier (iOS Keychain). |
| `x-auth-token` | `r2Jf0uY0w8lq6H1pZb9oS3cXyVQeT4nKmA7dGzW5iE` | Device secret token received upon registration (iOS Keychain). |
| `x-device-id` | `4b7e9d10-38cf-4a11-a89c-0c5092a58dac` | Apple's `identifierForVendor` (device auditing & abuse protection). |
| `devicetype` | `ios` | Client platform (`ios` or `android`). |

### 3.2 Socket Handshake Authentication

Sent in the Socket.IO connection payload:
```swift
manager = SocketManager(socketURL: URL(string: "https://drawing-widget-backend.onrender.com/v1")!, config: [
    .log(false),
    .compress,
    .forceWebsockets(true),
    .connectParams([
        "userId": currentUserId,
        "token": currentAuthToken
    ])
])
```
Or via handshake `auth`:
```javascript
const socket = io("https://drawing-widget-backend.onrender.com/v1", {
  auth: {
    userId: "8f3c1a2e-...",
    token: "r2Jf0uY0..."
  }
});
```

### 3.3 Auth Errors

* **REST 401 Unauthorized:**
  ```json
  {
    "success": false,
    "message": "Your session is no longer valid. Reinstall the app or contact support.",
    "data": null
  }
  ```
* **Socket Connect Error:**
  `connect_error Unauthorized: invalid token`

---

## 4. REST API Reference

All responses follow the standard envelope:
```json
{
  "success": true,
  "message": "OK",
  "data": { ... }
}
```

### 4.1 User Registration (`POST /api/v1/users/register`)
Called on every app launch. Returns `auth_token` on first registration.
* **Path:** `POST /api/v1/users/register`
* **Body:**
  ```json
  {
    "name": "Sunny Otter",
    "profile_image": "A4",
    "platform": "ios"
  }
  ```
* **First Registration Response (200 OK):**
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
* **Subsequent Registration (with `x-auth-token` header):**
  Returns `{ user_id, friend_code }` without `auth_token`.

---

### 4.2 Lookup by Code (`GET /api/v1/users/by-code/:code`)
Rate limited to 20 lookups/min.
* **Path:** `GET /api/v1/users/by-code/KT7M-PQ2X`
* **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
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

### 4.3 Send Friend Request (`POST /api/v1/friend-requests`)
Sends a request to another user.
* **By Friend Code (Add Friend sheet):**
  ```json
  {
    "friend_code": "KT7M-PQ2X"
  }
  ```
* **By User ID (Post-Match pop-up):**
  ```json
  {
    "user_id": "8f3c1a2e-0002-4000-8000-000000000002",
    "game": "shoot"
  }
  ```
* **Response (201 Created):**
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
      "request": {
        "request_id": "0b7e3c1a-6f2d-4a8e-9b51-2c7d4e9f1a30",
        "from": {
          "user_id": "8f3c1a2e-0001-4000-8000-000000000001",
          "name": "Alice",
          "profile_image": "A1",
          "friend_code": "ABCD2345"
        },
        "to": {
          "user_id": "8f3c1a2e-0002-4000-8000-000000000002",
          "name": "Sunny Otter",
          "profile_image": "A4",
          "friend_code": "KT7MPQ2X"
        },
        "source": "code",
        "game": null,
        "created_at": "2026-11-19T10:15:00.000Z",
        "expires_at": "2026-11-26T10:15:00.000Z"
      }
    }
  }
  ```
* **Auto-Accept Response (200 OK):**
  When counterpart already sent a pending request to caller:
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
      "friend": {
        "user_id": "8f3c1a2e-0002-4000-8000-000000000002",
        "name": "Sunny Otter",
        "profile_image": "A4",
        "friend_code": "KT7MPQ2X",
        "is_online": true,
        "status": "online",
        "game": null
      },
      "auto_accepted": true
    }
  }
  ```

#### Strict 10-Check Validation Sequence:
1. **Code Format:** 400 `"Friend codes are 8 letters and numbers"`
2. **User Exists:** 404 `"No player found with code <CODE>"` / `"Player not found"`
3. **Not Yourself:** 400 `"That's your own friend code. Share it with a friend instead."`
4. **Not Already Friends:** 409 `"You're already friends with <Name>"`
5. **Played Together (Match body only):** 403 `"You can only add players you just played with"`
6. **Counterpart Request Exists:** Auto-accepts, creates mutual friendship, returns 200 `{ friend, auto_accepted: true }`.
7. **Pending Request Exists:** 409 `"You already sent <Name> a request"`
8. **Friend Limits (<200):** 409 `"You can have up to 200 friends"` / `"<Name> can't add more friends"`
9. **Declined Cooldown (<24h):** 429 `"You can send <Name> another request later"`
10. **Rate Limit (<30/hr):** 429 `"Too many requests. Wait a bit and try again."`

---

### 4.4 List Open Friend Requests (`GET /api/v1/friend-requests`)
Returns pending and unexpired requests, newest first.
* **Path:** `GET /api/v1/friend-requests`
* **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
      "incoming": [ ...requests ],
      "outgoing": [ ...requests ]
    }
  }
  ```

---

### 4.5 Accept Friend Request (`POST /api/v1/friend-requests/:request_id/accept`)
Receiver only. Establishes mutual friendship and removes receiver's notification.
* **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
      "friend": {
        "user_id": "8f3c1a2e-0001-4000-8000-000000000001",
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
* **Sender gets:** `friend:request:accepted` with receiver's friend object.

---

### 4.6 Decline Friend Request (`POST /api/v1/friend-requests/:request_id/decline`)
Receiver only. Starts 24-hour decline cooldown.
* **Response (200 OK):** `{ "success": true, "message": "OK", "data": null }`
* **Sender gets:** `friend:request:ended` with `reason: "DECLINED"`.

---

### 4.7 Cancel Friend Request (`DELETE /api/v1/friend-requests/:request_id`)
Sender only.
* **Response (200 OK):** `{ "success": true, "message": "OK", "data": null }`
* **Receiver gets:** `friend:request:ended` with `reason: "CANCELLED"` and `notification:removed`.

---

### 4.8 List Notifications (`GET /api/v1/notifications`)
Returns active notifications from the last 7 days.
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
          "request": { ...request_object }
        }
      ]
    }
  }
  ```

---

### 4.9 Acknowledge Notifications (`POST /api/v1/notifications/ack`)
Deletes caller's acknowledged `missed_invite` notifications. Pending `friend_request` items are skipped (only leave when answered or expired).
* **Body:**
  ```json
  {
    "notification_ids": ["5d1f0e4b-..."]
  }
  ```
  Or clear all missed invites:
  ```json
  {
    "all": true
  }
  ```
* **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
      "removed": 1
    }
  }
  ```

---

### 4.10 List Friends (`GET /api/v1/friends`)
Returns all mutual friends enriched with live presence.
* **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
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
  }
  ```

---

### 4.11 Remove Friend (`DELETE /api/v1/friends/:user_id`)
Mutual removal. The other user receives `friend:removed`.
* **Response (200 OK):** `{ "success": true, "message": "OK", "data": null }`

---

## 5. Real-Time Socket Events Reference

All events are emitted to the personal user room `user:<user_id>`.

| Event Name | Direction | Payload | Description |
| :--- | :---: | :--- | :--- |
| `friend:request:received` | S $\to$ C | `{ request }` | Receiver gets alerted of an incoming friend request. |
| `friend:request:accepted` | S $\to$ C | `{ request_id, friend }` | Sender gets alerted when their friend request is accepted. |
| `friend:request:ended` | S $\to$ C | `{ request_id, reason }` | Receiver or sender alerted when request ends (`"DECLINED"`, `"CANCELLED"`, `"EXPIRED"`). |
| `notification:new` | S $\to$ C | `{ notification }` | User inbox receives a new friend request or missed invite (or duplicate refresh). |
| `notification:removed` | S $\to$ C | `{ notification_id }` | User inbox removes an item (accepted, declined, cancelled, expired, or acked). |
| `friend:presence` | S $\to$ C | `{ user_id, status, game }` | Friend changed presence state (`online`, `in_game`, `offline`). |
| `friends:presence` | S $\to$ C | `{ friends: [{ user_id, status, game }] }` | Sent on socket connect with all friends' current states. |
| `invite:send` | C $\to$ S | `{ to_user_id, game, room_code }` | Host invites online friend to waiting match. Ack: `{ ok, invite_id, expires_at }`. |
| `invite:received` | S $\to$ C | `{ invite_id, game, room_code, from, expires_at }` | Friend receives 60s game invite banner. |
| `invite:respond` | C $\to$ S | `{ invite_id, accept: true/false }` | Friend accepts or declines game invite. |
| `invite:accepted` | S $\to$ C | `{ invite_id, by_user_id, game, room_code }` | Host waiting modal dismisses, friend joins lobby. |
| `invite:declined` | S $\to$ C | `{ invite_id, by_user_id }` | Host receives decline notification. |
| `invite:cancelled` | S $\to$ C | `{ invite_id, reason }` | Invite cancelled (`"GAME_FULL"`, `"HOST_LEFT"`, `"REPLACED"`, `"CANCELLED"`). |
| `invite:expired` | S $\to$ C | `{ invite_id }` | 60s timer expires. Both host and friend receive expiration; friend gets `missed_invite` (`reason: "NO_ANSWER"`). |

---

## 6. Game Invites Changes & Missed Invite Triggers

1. **Friend Offline on `invite:send`:**
   * Returns ack: `{ ok: false, code: "FRIEND_OFFLINE", error: "<Name> is offline. We'll let them know you invited them." }`.
   * Automatically records a `missed_invite` notification for the friend with `reason: "OFFLINE"`.
   * 30-minute deduplication: If the host taps invite again within 30 minutes, updates the existing row's `created_at` and `reason` instead of creating duplicates.
2. **60-Second Timeout Unanswered:**
   * Emits `invite:expired` to both players.
   * Automatically records a `missed_invite` notification for the friend with `reason: "NO_ANSWER"`.
   * Emits `notification:new` to the friend.
3. **No Notification Created For:**
   * Friend declined (`accept: false`).
   * Cancelled for any reason (`CANCELLED`, `REPLACED`, `HOST_LEFT`, `GAME_FULL`).
   * Busy / not friends / game not found errors.

---

## 7. iOS Keychain & Token Management (Swift Snippet)

```swift
import Foundation
import Security

struct KeychainHelper {
    static let service = "com.drawingwidget.auth"
    
    static func save(key: String, value: String) {
        let data = Data(value.utf8)
        let query = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
            kSecValueData: data
        ] as [CFString: Any]
        
        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
    }
    
    static func get(key: String) -> String? {
        let query = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ] as [CFString: Any]
        
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data {
            return String(data: data, encoding: .utf8)
        }
        return nil
    }
}
```

On app launch:
```swift
func registerUser() {
    let userId = KeychainHelper.get(key: "user_id") ?? UUID().uuidString.lowercased()
    KeychainHelper.save(key: "user_id", value: userId)
    let authToken = KeychainHelper.get(key: "auth_token")
    
    var request = URLRequest(url: URL(string: "https://drawing-widget-backend.onrender.com/api/v1/users/register")!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(userId, forHTTPHeaderField: "x-user-id")
    if let token = authToken {
        request.setValue(token, forHTTPHeaderField: "x-auth-token")
    }
    request.setValue(UIDevice.current.identifierForVendor?.uuidString ?? "", forHTTPHeaderField: "x-device-id")
    request.setValue("ios", forHTTPHeaderField: "devicetype")
    
    let body: [String: Any] = ["name": "Sunny Otter", "profile_image": "A4", "platform": "ios"]
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    
    URLSession.shared.dataTask(with: request) { data, _, _ in
        guard let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let responseData = json["data"] as? [String: Any] else { return }
        
        // Save initial auth token if received
        if let token = responseData["auth_token"] as? String {
            KeychainHelper.save(key: "auth_token", value: token)
        }
    }.resume()
}
```
