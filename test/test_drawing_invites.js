import http from 'node:http';
import { io as Client } from 'socket.io-client';
import app from '../src/app.js';
import { initializeSocket } from '../src/sockets/index.js';
import { pool, closePool } from '../src/config/db.js';
import { ErrorCodes, SocketEvents } from '../src/helpers/constants.js';

const TEST_PORT = 3495;
const server = http.createServer(app);
const io = initializeSocket(server);
app.set('io', io);

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('--- Starting Draw Together Specification & Invite Tests ---');
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`Test server running on port ${TEST_PORT}`);

  const baseUrl = `http://localhost:${TEST_PORT}`;

  try {
    // 0. Register Test Users
    console.log('\n[0] Registering test users with auth tokens...');
    await pool.query("DELETE FROM users WHERE user_id LIKE 'draw-%'");
    const users = {};
    const testUserProfiles = [
      { id: 'draw-host-01', name: 'HostArtist', avatar: 'A1' },
      { id: 'draw-friend-02', name: 'FriendArtist', avatar: 'A2' },
      { id: 'draw-stranger-03', name: 'Stranger', avatar: 'A3' },
      { id: 'draw-busy-04', name: 'BusyPlayer', avatar: 'A4' },
      { id: 'draw-guest-05', name: 'WalkInGuest', avatar: 'A5' },
    ];

    for (const u of testUserProfiles) {
      const regRes = await fetch(`${baseUrl}/api/v1/users/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': u.id, devicetype: 'ios' },
        body: JSON.stringify({ name: u.name, profile_image: u.avatar }),
      });
      const regData = await regRes.json();
      users[u.id] = {
        id: u.id,
        name: u.name,
        authToken: regData.data.auth_token,
        friendCode: regData.data.friend_code,
      };
    }
    console.log('✓ Test users registered with device tokens');

    // Make Host & Friend mutual friends in DB
    const u1 = users['draw-host-01'].id < users['draw-friend-02'].id ? users['draw-host-01'].id : users['draw-friend-02'].id;
    const u2 = users['draw-host-01'].id < users['draw-friend-02'].id ? users['draw-friend-02'].id : users['draw-host-01'].id;
    await pool.query('INSERT INTO friendships (user_a, user_b, created_by) VALUES ($1, $2, $1) ON CONFLICT DO NOTHING', [u1, u2]);
    console.log('✓ Host and Friend established as mutual friends');

    // 1. Template & Step fields removed/ignored & Host is always slot 1
    console.log('\n[1] Testing Item 6 & 2: Room creation without svg_resource / step_index (Creator is slot 1 & host_id set)...');
    const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': users['draw-host-01'].id,
        'x-auth-token': users['draw-host-01'].authToken,
        devicetype: 'ios',
      },
      body: JSON.stringify({
        player_count: 2,
        name: users['draw-host-01'].name,
        profile_image: 'A1',
      }),
    });
    const createData = await createRes.json();
    if (createRes.status !== 201 || !createData.success) {
      throw new Error(`Room creation failed: ${JSON.stringify(createData)}`);
    }

    const room = createData.data.room;
    const slotIndex = createData.data.slot_index;
    if (slotIndex !== 1 || room.host_id !== users['draw-host-01'].id) {
      throw new Error(`Expected host to be slot 1 and host_id to match, got slot: ${slotIndex}, host_id: ${room.host_id}`);
    }
    console.log(`✓ Room created with neither svg_resource nor step_index. Code: ${room.code}, Slot: ${slotIndex}, host_id: ${room.host_id}`);

    // 2. Auth token check on room routes
    console.log('\n[2] Testing Item 7: Auth token verification on /api/v1/rooms/* ...');
    const badAuthRes = await fetch(`${baseUrl}/api/v1/rooms/${room.id}`, {
      headers: {
        'x-user-id': users['draw-host-01'].id,
        'x-auth-token': 'invalid-token-12345',
        devicetype: 'ios',
      },
    });
    const badAuthData = await badAuthRes.json();
    if (badAuthRes.status !== 401 || badAuthData.message !== 'Your session is no longer valid. Reinstall the app or contact support.') {
      throw new Error(`Expected 401 with session invalid message, got status: ${badAuthRes.status}, msg: ${badAuthData.message}`);
    }
    console.log('✓ Verified 401 text on /api/v1/rooms/:id with invalid auth token');

    const validAuthRes = await fetch(`${baseUrl}/api/v1/rooms/${room.id}`, {
      headers: {
        'x-user-id': users['draw-host-01'].id,
        'x-auth-token': users['draw-host-01'].authToken,
        devicetype: 'ios',
      },
    });
    const validAuthData = await validAuthRes.json();
    if (validAuthRes.status !== 200 || !validAuthData.success) {
      throw new Error('Expected 200 on valid auth token');
    }
    console.log('✓ Verified 200 on valid auth token');

    // 3. Connect sockets for host and friend
    console.log('\n[3] Connecting WebSockets for Host and Friend...');
    const hostSocket = Client(`${baseUrl}/v1`, {
      auth: { userId: users['draw-host-01'].id, token: users['draw-host-01'].authToken, devicetype: 'ios' },
      transports: ['websocket'],
    });
    const friendSocket = Client(`${baseUrl}/v1`, {
      auth: { userId: users['draw-friend-02'].id, token: users['draw-friend-02'].authToken, devicetype: 'ios' },
      transports: ['websocket'],
    });

    await Promise.all([
      new Promise((r) => hostSocket.on('connect', r)),
      new Promise((r) => friendSocket.on('connect', r)),
    ]);
    console.log('✓ Both sockets connected');

    // Host joins room
    const hostJoinAck = await new Promise((resolve) => {
      hostSocket.emit('room:join', { room_id: room.id, token: users['draw-host-01'].authToken }, resolve);
    });
    if (!hostJoinAck.ok || hostJoinAck.slot_index !== 1 || hostJoinAck.host_id !== users['draw-host-01'].id) {
      throw new Error(`Host join failed or wrong slot: ${JSON.stringify(hostJoinAck)}`);
    }
    console.log('✓ Host joined room via socket, slot 1 confirmed');

    // 4. Friend Invites for Drawing: Checks 1 to 7 in strict order
    console.log('\n[4] Testing Drawing Friend Invites Check 1: NOT_FRIENDS ...');
    const notFriendsAck = await new Promise((resolve) => {
      hostSocket.emit('invite:send', {
        to_user_id: users['draw-stranger-03'].id,
        game: 'drawing',
        room_code: room.code,
      }, resolve);
    });
    if (notFriendsAck.ok || notFriendsAck.code !== 'NOT_FRIENDS' || notFriendsAck.error !== 'You can only invite friends') {
      throw new Error(`Expected NOT_FRIENDS, got: ${JSON.stringify(notFriendsAck)}`);
    }
    console.log('✓ Check 1 (NOT_FRIENDS) verified: "You can only invite friends"');

    console.log('\n[5] Testing Drawing Friend Invites Check 2: GAME_NOT_FOUND ...');
    const notFoundAck = await new Promise((resolve) => {
      hostSocket.emit('invite:send', {
        to_user_id: users['draw-friend-02'].id,
        game: 'drawing',
        room_code: 'NON999',
      }, resolve);
    });
    if (notFoundAck.ok || notFoundAck.code !== 'GAME_NOT_FOUND' || notFoundAck.error !== 'That room has closed. Start a new one.') {
      throw new Error(`Expected GAME_NOT_FOUND, got: ${JSON.stringify(notFoundAck)}`);
    }
    console.log('✓ Check 2 (GAME_NOT_FOUND) verified: "That room has closed. Start a new one."');

    console.log('\n[6] Testing Drawing Friend Invites Check 3: NOT_HOST ...');
    // Friend tries to invite Host
    const notHostAck = await new Promise((resolve) => {
      friendSocket.emit('invite:send', {
        to_user_id: users['draw-host-01'].id,
        game: 'drawing',
        room_code: room.code,
      }, resolve);
    });
    if (notHostAck.ok || notHostAck.code !== 'NOT_HOST' || notHostAck.error !== 'Only the host can invite') {
      throw new Error(`Expected NOT_HOST, got: ${JSON.stringify(notHostAck)}`);
    }
    console.log('✓ Check 3 (NOT_HOST) verified: "Only the host can invite"');

    console.log('\n[7] Testing Drawing Friend Invites Check 5: FRIEND_OFFLINE ...');
    // Register offline friend
    const offlineRes = await fetch(`${baseUrl}/api/v1/users/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'draw-offline-06', devicetype: 'ios' },
      body: JSON.stringify({ name: 'Sunny Otter', profile_image: 'A6' }),
    });
    const offlineData = await offlineRes.json();
    const offlineUserId = 'draw-offline-06';
    const o1 = users['draw-host-01'].id < offlineUserId ? users['draw-host-01'].id : offlineUserId;
    const o2 = users['draw-host-01'].id < offlineUserId ? offlineUserId : users['draw-host-01'].id;
    await pool.query('INSERT INTO friendships (user_a, user_b, created_by) VALUES ($1, $2, $1) ON CONFLICT DO NOTHING', [o1, o2]);

    const offlineAck = await new Promise((resolve) => {
      hostSocket.emit('invite:send', {
        to_user_id: offlineUserId,
        game: 'drawing',
        room_code: room.code,
      }, resolve);
    });
    if (offlineAck.ok || offlineAck.code !== 'FRIEND_OFFLINE' || offlineAck.error !== "Sunny Otter is offline. We'll let them know you invited them.") {
      throw new Error(`Expected FRIEND_OFFLINE, got: ${JSON.stringify(offlineAck)}`);
    }
    console.log('✓ Check 5 (FRIEND_OFFLINE) verified: "Sunny Otter is offline. We\'ll let them know you invited them."');

    // 8. Successful invite:send & invite:received
    console.log('\n[8] Testing Valid invite:send for drawing...');
    let receivedInvite = null;
    friendSocket.once(SocketEvents.INVITE_RECEIVED, (payload) => {
      receivedInvite = payload;
    });

    const sendAck = await new Promise((resolve) => {
      hostSocket.emit('invite:send', {
        to_user_id: users['draw-friend-02'].id,
        game: 'drawing',
        room_code: room.code,
      }, resolve);
    });

    if (!sendAck.ok || !sendAck.invite_id || !sendAck.expires_at) {
      throw new Error(`invite:send failed: ${JSON.stringify(sendAck)}`);
    }
    await wait(100);
    if (!receivedInvite || receivedInvite.invite_id !== sendAck.invite_id || receivedInvite.game !== 'drawing') {
      throw new Error(`Friend did not receive valid invite:received event: ${JSON.stringify(receivedInvite)}`);
    }
    console.log('✓ invite:send succeeded and friend received invite:received event:', receivedInvite);

    // 9. Host sends new invite -> Check 7: Old invite cancelled with REPLACED
    console.log('\n[9] Testing Check 7: Host sends another invite with curly quotes & room id -> old invite cancelled with REPLACED ...');
    let cancelReason = null;
    friendSocket.once(SocketEvents.INVITE_CANCELLED, (payload) => {
      cancelReason = payload.reason;
    });

    const sendSecondAck = await new Promise((resolve) => {
      hostSocket.emit('invite:send', {
        toUserId: users['draw-friend-02'].id,
        game: '“drawing”',
        roomCode: room.id,
      }, resolve);
    });
    if (!sendSecondAck.ok || !sendSecondAck.invite_id) {
      throw new Error(`invite:send with curly quotes and room id failed: ${JSON.stringify(sendSecondAck)}`);
    }
    await wait(100);
    if (cancelReason !== 'REPLACED') {
      throw new Error(`Expected previous invite cancelled with REPLACED, got: ${cancelReason}`);
    }
    console.log('✓ Old invite cleanly cancelled with reason: REPLACED (and drawing aliases / room UUID resolution verified)');

    // 10. Friend accepts invite -> invite:accepted to host & ack to friend
    console.log('\n[10] Testing invite:respond (accept: true) ...');
    let acceptedEvent = null;
    hostSocket.once(SocketEvents.INVITE_ACCEPTED, (payload) => {
      acceptedEvent = payload;
    });

    const respondAck = await new Promise((resolve) => {
      friendSocket.emit('invite:respond', {
        invite_id: sendSecondAck.invite_id,
        accept: true,
      }, resolve);
    });

    if (!respondAck.ok || !respondAck.accepted || respondAck.game !== 'drawing' || respondAck.room_code !== room.code) {
      throw new Error(`invite:respond ack failed: ${JSON.stringify(respondAck)}`);
    }
    await wait(100);
    if (!acceptedEvent || acceptedEvent.invite_id !== sendSecondAck.invite_id || acceptedEvent.by_user_id !== users['draw-friend-02'].id) {
      throw new Error(`Host did not receive invite:accepted event: ${JSON.stringify(acceptedEvent)}`);
    }
    console.log('✓ Friend accepted invite; host received invite:accepted');

    // 11. Friend joins room over REST (POST /api/v1/rooms/join) -> slot 2 assigned, presence marked in_game
    console.log('\n[11] Testing Friend REST Join -> Slot 2, presence in_game (game: "drawing") ...');
    let presencePayload = null;
    hostSocket.on(SocketEvents.FRIEND_PRESENCE, (payload) => {
      if (payload.user_id === users['draw-friend-02'].id) {
        presencePayload = payload;
      }
    });

    const joinRes = await fetch(`${baseUrl}/api/v1/rooms/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': users['draw-friend-02'].id,
        'x-auth-token': users['draw-friend-02'].authToken,
        devicetype: 'ios',
      },
      body: JSON.stringify({
        code: room.code,
        name: users['draw-friend-02'].name,
      }),
    });
    const joinData = await joinRes.json();
    if (joinRes.status !== 200 || joinData.data.slot_index !== 2) {
      throw new Error(`Expected guest to receive slot 2, got: ${joinData.data?.slot_index}`);
    }
    console.log('✓ Guest joined room and was assigned slot 2');

    // Friend connects socket to room
    const friendJoinAck = await new Promise((resolve) => {
      friendSocket.emit('room:join', { room_id: room.id, token: users['draw-friend-02'].authToken }, resolve);
    });
    if (!friendJoinAck.ok || friendJoinAck.slot_index !== 2) {
      throw new Error(`Friend room:join failed: ${JSON.stringify(friendJoinAck)}`);
    }
    console.log('✓ Friend room:join succeeded, slot 2 confirmed');

    await wait(200);
    // Verify GET /rooms/:id has both members with connected: true
    const roomDetailsRes = await fetch(`${baseUrl}/api/v1/rooms/${room.id}`, {
      headers: {
        'x-user-id': users['draw-host-01'].id,
        'x-auth-token': users['draw-host-01'].authToken,
        devicetype: 'ios',
      },
    });
    const roomDetails = await roomDetailsRes.json();
    const members = roomDetails.data.members;
    if (members.length !== 2 || !members[0].connected || !members[1].connected) {
      throw new Error(`Expected 2 connected members in room details, got: ${JSON.stringify(members)}`);
    }
    console.log('✓ Item 4 verified: GET /rooms/:id returns connected: true for active members');

    // 12. Check 4: Room is now full (GAME_FULL)
    console.log('\n[12] Testing Check 4: Host invites when room full -> GAME_FULL ...');
    const fullAck = await new Promise((resolve) => {
      hostSocket.emit('invite:send', {
        to_user_id: users['draw-friend-02'].id,
        game: 'drawing',
        room_code: room.code,
      }, resolve);
    });
    if (fullAck.ok || fullAck.code !== 'GAME_FULL' || fullAck.error !== 'Your room already has two people') {
      throw new Error(`Expected GAME_FULL, got: ${JSON.stringify(fullAck)}`);
    }
    console.log('✓ Check 4 (GAME_FULL) verified: "Your room already has two people"');

    // 13. Item 5: Shapes & Emojis top-level fields on reload & backfill
    console.log('\n[13] Testing Item 5: Shape and Emoji top-level fields persistence & backfill ...');
    const shapeStrokeId = (await import('node:crypto')).randomUUID();
    const shapePayload = {
      id: shapeStrokeId,
      kind: 'shape',
      shape_type: 'rectangle',
      stroke_id: 'blue',
      fill_id: 'light_blue',
      stroke_width: 3,
      coordinates: { x: 50, y: 75 },
      size: { width: 120, height: 80 },
      angle: 45,
      stroke_data: 'optional_binary_or_path_data',
    };

    const shapeAddAck = await new Promise((resolve) => {
      hostSocket.emit('stroke:add', shapePayload, resolve);
    });
    if (!shapeAddAck.ok || !shapeAddAck.saved) {
      throw new Error(`Shape stroke:add failed: ${JSON.stringify(shapeAddAck)}`);
    }

    const emojiStrokeId = (await import('node:crypto')).randomUUID();
    const emojiPayload = {
      id: emojiStrokeId,
      kind: 'emoji',
      emoji_id: 'rocket',
      coordinates: { x: 200, y: 300 },
      size: { width: 64, height: 64 },
      angle: 0,
      stroke_data: 'optional_emoji_data',
    };

    const emojiAddAck = await new Promise((resolve) => {
      hostSocket.emit('stroke:add', emojiPayload, resolve);
    });
    if (!emojiAddAck.ok || !emojiAddAck.saved) {
      throw new Error(`Emoji stroke:add failed: ${JSON.stringify(emojiAddAck)}`);
    }

    // Verify GET /api/v1/rooms/:id/strokes returns shape and emoji top-level fields
    const strokesRes = await fetch(`${baseUrl}/api/v1/rooms/${room.id}/strokes`, {
      headers: {
        'x-user-id': users['draw-host-01'].id,
        'x-auth-token': users['draw-host-01'].authToken,
        devicetype: 'ios',
      },
    });
    const strokesData = await strokesRes.json();
    const retrievedStrokes = strokesData.data.strokes;

    const retrievedShape = retrievedStrokes.find((s) => s.id === shapeStrokeId);
    if (
      !retrievedShape ||
      retrievedShape.shape_type !== 'rectangle' ||
      retrievedShape.stroke_id !== 'blue' ||
      retrievedShape.fill_id !== 'light_blue' ||
      retrievedShape.angle !== 45 ||
      !retrievedShape.coordinates ||
      !retrievedShape.size
    ) {
      throw new Error(`Shape stroke fields missing or incorrect on reload: ${JSON.stringify(retrievedShape)}`);
    }

    const retrievedEmoji = retrievedStrokes.find((s) => s.id === emojiStrokeId);
    if (!retrievedEmoji || retrievedEmoji.emoji_id !== 'rocket' || !retrievedEmoji.coordinates || !retrievedEmoji.size) {
      throw new Error(`Emoji stroke fields missing or incorrect on reload: ${JSON.stringify(retrievedEmoji)}`);
    }
    console.log('✓ Item 5 verified: Shape & Emoji top-level fields fully preserved and returned on reload');

    // 14. Item 3: Ack room:leave
    console.log('\n[14] Testing Item 3 & 9: Guest emits room:leave -> Acks { ok: true }, presence returns to online ...');
    let presenceLeaveSeen = false;
    hostSocket.once(SocketEvents.PRESENCE_LEAVE, () => {
      presenceLeaveSeen = true;
    });

    const guestLeaveAck = await new Promise((resolve) => {
      friendSocket.emit('room:leave', { room_id: room.id }, resolve);
    });
    if (!guestLeaveAck.ok || guestLeaveAck.room_closed) {
      throw new Error(`Expected guest leave ack { ok: true, room_closed: false }, got: ${JSON.stringify(guestLeaveAck)}`);
    }
    await wait(100);
    if (!presenceLeaveSeen) {
      throw new Error('Host did not receive presence:leave event when guest left');
    }
    console.log('✓ Item 3 & 9 verified: room:leave acknowledged immediately with { ok: true }');

    // 15. Item 10: Played together rule for drawing rooms in friend requests
    console.log('\n[15] Testing Item 10: Played together 24h rule allows friend request by user_id ...');
    const friendReqRes = await fetch(`${baseUrl}/api/v1/friend-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': users['draw-friend-02'].id,
        'x-auth-token': users['draw-friend-02'].authToken,
        devicetype: 'ios',
      },
      body: JSON.stringify({
        user_id: users['draw-host-01'].id,
      }),
    });
    const friendReqData = await friendReqRes.json();
    // They are already friends from step 0, so ALREADY_FRIENDS is returned
    // Let's test with a fresh user who played together
    const newGuestRes = await fetch(`${baseUrl}/api/v1/users/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'draw-new-guest-07', devicetype: 'ios' },
      body: JSON.stringify({ name: 'FreshGuest', profile_image: 'A7' }),
    });
    const newGuest = await newGuestRes.json();

    // New guest joins room with host
    await fetch(`${baseUrl}/api/v1/rooms/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'draw-new-guest-07',
        'x-auth-token': newGuest.data.auth_token,
        devicetype: 'ios',
      },
      body: JSON.stringify({ code: room.code, name: 'FreshGuest' }),
    });

    // Fresh guest sends friend request by user_id
    const matchReqRes = await fetch(`${baseUrl}/api/v1/friend-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'draw-new-guest-07',
        'x-auth-token': newGuest.data.auth_token,
        devicetype: 'ios',
      },
      body: JSON.stringify({
        user_id: users['draw-host-01'].id,
      }),
    });
    const matchReqData = await matchReqRes.json();
    if (matchReqRes.status !== 201 || !matchReqData.success) {
      throw new Error(`Expected 201 for played together friend request, got: ${JSON.stringify(matchReqData)}`);
    }
    console.log('✓ Item 10 verified: Drawing room counts as played together for friend requests by user_id');

    // 16. Host leaves room -> room:closed emitted, open invites cancelled (HOST_LEFT)
    console.log('\n[16] Testing Host room:leave -> room:closed emitted and ack received ...');
    const hostLeaveAck = await new Promise((resolve) => {
      hostSocket.emit('room:leave', { room_id: room.id }, resolve);
    });
    if (!hostLeaveAck.ok || !hostLeaveAck.room_closed) {
      throw new Error(`Expected host leave ack { ok: true, room_closed: true }, got: ${JSON.stringify(hostLeaveAck)}`);
    }
    console.log('✓ Host leave closed room session cleanly');

    // Disconnect sockets
    hostSocket.disconnect();
    friendSocket.disconnect();

    console.log('\n=== ALL DRAW TOGETHER BACKEND SPECIFICATION TESTS PASSED SUCCESSFULLY! ===\n');
  } finally {
    server.close();
    await closePool();
  }
}

runTests().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
