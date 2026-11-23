# Draw Together: Room Presence, Member Connectivity & Disconnect Lifecycle
**Frontend & iOS Developer Cheat Sheet**  
*Updated: November 23, 2026*  
*Backend Version: 1.1.0 (`drawing-invites-v2`)*

---

## 1. Quick Summary of Changes

| Feature | Behavior |
| :--- | :--- |
| **Member `connected` Flag** | `GET /api/v1/rooms/:id` returns `connected: true/false` on every member in `members[]`. |
| **Room Code or UUID in REST** | `GET /api/v1/rooms/:id` accepts **either** the 36-char Room UUID or the 6-character room code (e.g. `JA4CB6`). |
| **5-Second Disconnect Grace** | If a peer's socket drops without emitting `room:leave`, their slot remains reserved for **5 seconds** (during which `connected: false`). Once 5s passes, they are removed from the room. |
| **Live `room:members` Broadcast** | When a disconnected peer is removed at the 5-second mark, remaining peers in the room automatically receive a `room:members` event with the updated player list. |
| **In-Game Presence for Drawing** | When the 2nd player joins (via REST `POST /api/v1/rooms/join` or socket `room:join`), both players transition to `status: "in_game", game: "drawing"`, and `friend:presence` is broadcast to mutual friends. |
| **Leaving Room Restores Online** | When players leave (`room:leave` or `POST /api/v1/rooms/leave`), their presence automatically transitions back to `status: "online", game: null`. |

---

## 2. REST Endpoints Specification

### 2.1 Get Room Metadata & Members
`GET /api/v1/rooms/:id` (accepts UUID or 6-character code)

#### Headers Required:
```http
x-user-id: 8f3c1a2e-4b7e-4d9a-9b1d-2c3e4f5a6b7c
x-auth-token: abcdef123456...
devicetype: ios
```

#### Success Response (`200 OK`):
```json
{
  "success": true,
  "message": "Room details retrieved.",
  "data": {
    "room": {
      "id": "545cc516-9a4c-44b8-bccd-f52abf206449",
      "code": "JA4CB6",
      "host_id": "8f3c1a2e-4b7e-4d9a-9b1d-2c3e4f5a6b7c",
      "player_count": 2,
      "device_type": "ios",
      "created_at": "2026-11-23T05:00:00.000Z",
      "started_at": null
    },
    "members": [
      {
        "user_id": "8f3c1a2e-4b7e-4d9a-9b1d-2c3e4f5a6b7c",
        "slot_index": 1,
        "name": "HostArtist",
        "profile_image": "A1",
        "joined_at": "2026-11-23T05:00:00.000Z",
        "connected": true
      },
      {
        "user_id": "1c2d3e4f-5a6b-7c8d-9e0f-1a2b3c4d5e6f",
        "slot_index": 2,
        "name": "FriendArtist",
        "profile_image": "A2",
        "joined_at": "2026-11-23T05:01:00.000Z",
        "connected": true
      }
    ]
  }
}
```

> **UI Tip:** If `member.connected == false`, display a dimmed avatar or a subtle "Reconnecting..." badge next to their name.

---

## 3. Disconnect & Drop Lifecycle (5-Second Grace Window)

When a player drops connection unexpectedly (e.g., app kill, signal loss, socket disconnect) without calling `room:leave`:

```
[Peer Socket Drops]
        │
        ├─► Server immediately emits `presence:leave` to room: { user_id, reason }
        ├─► `GET /api/v1/rooms/:id` reports `connected: false` for that member
        │
        ▼
   [5.0 s Grace Timer Running]
        │
        ├─► Case A: Peer reconnects within 5 s and sends `room:join`
        │       └─► Grace timer cancelled; peer reconnected cleanly (`reconnected: true`)
        │
        └─► Case B: 5.0 s passes without reconnect
                │
                ├─► If Non-Host drops:
                │       ├─► Slot 2 freed (`left_at` set in database)
                │       ├─► Server emits `room:members` to room with updated player list
                │       ├─► Host presence returns to `status: "online", game: null`
                │       └─► Subsequent `GET /api/v1/rooms/:id` has only host
                │
                └─► If Host drops:
                        ├─► Room closed session ended
                        ├─► Server emits `room:closed` to peers:
                        │     { reason: "HOST_DISCONNECTED", message: "The host has disconnected. Room session ended." }
                        └─► All room members presence returns to `online`
```

---

## 4. In-Game Presence (`friend:presence`)

When two friends are drawing together, their presence status updates across the app:

### Event: `friend:presence`
Emitted over Socket.IO (namespace `/v1`) to mutual friends:

```json
{
  "user_id": "1c2d3e4f-5a6b-7c8d-9e0f-1a2b3c4d5e6f",
  "status": "in_game",
  "game": "drawing"
}
```

* **When it turns `in_game`:** The moment the 2nd player joins the room (either via `POST /api/v1/rooms/join` or socket `room:join`). Both host and friend emit `in_game`.
* **When it turns back to `online`:** As soon as either player leaves (`room:leave` or `POST /api/v1/rooms/leave`), or after the 5s disconnect timeout expires.
  ```json
  {
    "user_id": "1c2d3e4f-5a6b-7c8d-9e0f-1a2b3c4d5e6f",
    "status": "online",
    "game": null
  }
  ```

---

## 5. iOS / Swift Implementation Examples

### 5.1 Room Member Model with `connected` Flag

```swift
struct RoomMember: Codable, Identifiable {
    var id: String { user_id }
    let user_id: String
    let slot_index: Int
    let name: String
    let profile_image: String?
    let joined_at: String
    let connected: Bool // NEW: true if socket is connected, false if temporarily dropped
}

struct RoomData: Codable {
    let room: RoomDetails
    let members: [RoomMember]
}
```

### 5.2 Listening to Live Room Updates

```swift
// Listen for peer dropping socket connection (shows "Reconnecting..." badge)
socket.on("presence:leave") { data, ack in
    guard let dict = data.first as? [String: Any],
          let userId = dict["user_id"] as? String else { return }
    
    DispatchQueue.main.async {
        // Mark member as disconnected in UI
        if let idx = viewModel.members.firstIndex(where: { $0.user_id == userId }) {
            viewModel.members[idx].connected = false
        }
    }
}

// Listen for peer reconnecting cleanly within 5s grace
socket.on("presence:join") { data, ack in
    guard let dict = data.first as? [String: Any],
          let userId = dict["user_id"] as? String else { return }
    
    DispatchQueue.main.async {
        if let idx = viewModel.members.firstIndex(where: { $0.user_id == userId }) {
            viewModel.members[idx].connected = true
        }
    }
}

// Listen for updated player list when a dropped member is removed after 5s
socket.on("room:members") { data, ack in
    guard let dict = data.first as? [String: Any],
          let membersData = try? JSONSerialization.data(withJSONObject: dict["members"] ?? []),
          let updatedMembers = try? JSONDecoder().decode([RoomMember].self, from: membersData) else { return }
    
    DispatchQueue.main.async {
        viewModel.members = updatedMembers
    }
}

// Listen for host disconnection closing the room session
socket.on("room:closed") { data, ack in
    guard let dict = data.first as? [String: Any] else { return }
    let reason = dict["reason"] as? String ?? "ROOM_CLOSED"
    let message = dict["message"] as? String ?? "The room has closed."
    
    DispatchQueue.main.async {
        viewModel.showRoomClosedAlert(message: message)
    }
}
```

### 5.3 Leaving Room with Immediate Ack

```swift
func leaveDrawingRoom(roomId: String, completion: @escaping () -> Void) {
    socket.emitWithAck("room:leave", ["room_id": roomId]).timingOut(after: 2.0) { data in
        // Server acks { ok: true, left: true }
        DispatchQueue.main.async {
            completion()
        }
    }
}
```

---

## 6. Verification Checklist

1. [x] `GET /api/v1/rooms/:id` includes `"connected": true` when player socket is connected.
2. [x] When a guest disconnects without `room:leave`, `GET /api/v1/rooms/:id` immediately shows `"connected": false` for that guest.
3. [x] After **5 seconds** without reconnecting, the guest slot is freed, and subsequent `GET /api/v1/rooms/:id` returns only the host.
4. [x] Remaining peer receives socket event `room:members` with the updated 1-player list.
5. [x] Mutual friends receive `friend:presence` with `{ status: "in_game", game: "drawing" }` when the 2nd person joins, and `{ status: "online", game: null }` when the room session ends.
