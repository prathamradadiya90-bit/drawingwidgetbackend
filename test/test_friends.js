import http from 'node:http';
import { io as Client } from 'socket.io-client';
import app from '../src/app.js';
import { initializeSocket } from '../src/sockets/index.js';
import { pool, closePool } from '../src/config/db.js';
import { runMigrations } from '../src/database/migrate.js';
import {
  normalizeFriendCode,
  isValidFriendCode,
  formatFriendCodeWithDash,
  generateRandomFriendCode,
} from '../src/services/friend.service.js';

const TEST_PORT = 3460;
const server = http.createServer(app);
const io = initializeSocket(server);
app.set('io', io);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const userTokens = new Map();

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const headers = { ...(options.headers || {}) };
  const uid = headers['x-user-id'] || headers['userid'];
  if (uid && userTokens.has(uid) && !headers['x-auth-token']) {
    headers['x-auth-token'] = userTokens.get(uid);
  }
  const res = await originalFetch(url, { ...options, headers });
  if (typeof url === 'string' && url.includes('/users/register') && res.ok) {
    const clone = res.clone();
    try {
      const data = await clone.json();
      if (data?.data?.auth_token && uid) {
        userTokens.set(uid, data.data.auth_token);
      }
    } catch {}
  }
  return res;
};

function createSocket(userId, deviceType = 'ios') {
  const token = userTokens.get(userId);
  return Client(`http://localhost:${TEST_PORT}/v1`, {
    transports: ['websocket'],
    forceNew: true,
    auth: {
      userId,
      user_id: userId,
      devicetype: deviceType,
      token,
    },
    query: {
      userId,
      token,
    },
    extraHeaders: {
      'x-user-id': userId,
      'x-auth-token': token || '',
      devicetype: deviceType,
    },
  });
}

async function runTests() {
  console.log('====================================================');
  console.log('   STARTING FRIENDS & INVITES COMPREHENSIVE TESTS   ');
  console.log('====================================================\n');

  await runMigrations();
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`Test server running on port ${TEST_PORT}\n`);

  const baseUrl = `http://localhost:${TEST_PORT}`;
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (!condition) {
      console.error(`❌ FAIL: ${message}`);
      failed++;
      throw new Error(message);
    }
    console.log(`✓ PASS: ${message}`);
    passed++;
  }

  try {
    // ----------------------------------------------------
    // TEST 1: Helper Unit Tests
    // ----------------------------------------------------
    console.log('\n--- [TEST 1: Helper Unit Tests] ---');
    assert(normalizeFriendCode('kt7m-pq2x') === 'KT7MPQ2X', 'Normalizes lowercase and dashes');
    assert(isValidFriendCode('KT7MPQ2X') === true, 'KT7MPQ2X is valid code');
    assert(isValidFriendCode('KT7M-PQ2X') === true, 'KT7M-PQ2X is valid with dash');
    assert(isValidFriendCode('KT7MPQ20') === false, '0 is not in alphabet');
    assert(isValidFriendCode('KT7MPQ21') === false, '1 is not in alphabet');
    assert(isValidFriendCode('KT7MPQ2O') === false, 'O is not in alphabet');
    assert(isValidFriendCode('KT7MPQ2I') === false, 'I is not in alphabet');
    assert(isValidFriendCode('SHORT') === false, 'Short code rejected');
    assert(formatFriendCodeWithDash('KT7MPQ2X') === 'KT7M-PQ2X', 'Formats with dash');

    // ----------------------------------------------------
    // TEST 2: User Registration (POST /users/register)
    // ----------------------------------------------------
    console.log('\n--- [TEST 2: User Registration (POST /users/register)] ---');
    const userAliceId = '8f3c1a2e-0001-4000-8000-000000000001';
    const userBobId = '8f3c1a2e-0002-4000-8000-000000000002';
    const userCharlieId = '8f3c1a2e-0003-4000-8000-000000000003';

    await pool.query('DELETE FROM users WHERE user_id IN ($1, $2, $3)', [userAliceId, userBobId, userCharlieId]);

    // Alice registers
    const regAliceRes = await fetch(`${baseUrl}/api/v1/users/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userAliceId,
        'x-device-id': 'device-alice-apple-vendor',
        devicetype: 'ios',
      },
      body: JSON.stringify({
        name: 'Alice',
        profile_image: 'A7',
        platform: 'ios',
      }),
    });
    const regAliceData = await regAliceRes.json();
    assert(regAliceData.success === true, 'Alice registration succeeded');
    assert(regAliceData.data.user_id === userAliceId, 'Alice user_id returned');
    assert(isValidFriendCode(regAliceData.data.friend_code), 'Alice friend_code generated correctly');
    const aliceFriendCode = regAliceData.data.friend_code;

    // Bob registers
    const regBobRes = await fetch(`${baseUrl}/api/v1/users/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userBobId,
        'x-device-id': 'device-bob-apple-vendor',
        devicetype: 'ios',
      },
      body: JSON.stringify({
        name: 'Sunny Otter',
        profile_image: 'A4',
        platform: 'ios',
      }),
    });
    const regBobData = await regBobRes.json();
    assert(regBobData.success === true, 'Bob registration succeeded');
    const bobFriendCode = regBobData.data.friend_code;
    assert(bobFriendCode !== aliceFriendCode, 'Bob friend_code is unique');

    // Alice registers again (upsert name and avatar)
    const updateAliceRes = await fetch(`${baseUrl}/api/v1/users/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userAliceId,
        devicetype: 'ios',
      },
      body: JSON.stringify({
        name: 'Alice Wonder',
        profile_image: 'A9',
      }),
    });
    const updateAliceData = await updateAliceRes.json();
    assert(updateAliceData.success === true, 'Alice re-registration updated info');
    assert(updateAliceData.data.friend_code === aliceFriendCode, 'Alice friend_code remained unchanged');

    // ----------------------------------------------------
    // TEST 3: Lookup by Code (GET /users/by-code/:code)
    // ----------------------------------------------------
    console.log('\n--- [TEST 3: Lookup by Code (GET /users/by-code/:code)] ---');
    // 3a. Lookup Bob by exact code
    const lookupBobRes = await fetch(`${baseUrl}/api/v1/users/by-code/${bobFriendCode}`, {
      headers: { 'x-user-id': userAliceId, devicetype: 'ios' },
    });
    const lookupBobData = await lookupBobRes.json();
    assert(lookupBobData.success === true, 'Lookup Bob succeeded');
    assert(lookupBobData.data.name === 'Sunny Otter', 'Bob name matches Sunny Otter');
    assert(lookupBobData.data.friend_code === bobFriendCode, 'Bob friend_code matches');

    // 3b. Lookup with dash and lowercase
    const dashedCode = `${bobFriendCode.slice(0, 4)}-${bobFriendCode.slice(4)}`.toLowerCase();
    const lookupDashedRes = await fetch(`${baseUrl}/api/v1/users/by-code/${dashedCode}`, {
      headers: { 'x-user-id': userAliceId, devicetype: 'ios' },
    });
    const lookupDashedData = await lookupDashedRes.json();
    assert(lookupDashedData.success === true, 'Lookup with dash and lowercase succeeded');
    assert(lookupDashedData.data.user_id === userBobId, 'Resolved to correct user_id');

    // 3c. Lookup own code -> 400
    const ownCodeRes = await fetch(`${baseUrl}/api/v1/users/by-code/${aliceFriendCode}`, {
      headers: { 'x-user-id': userAliceId, devicetype: 'ios' },
    });
    const ownCodeData = await ownCodeRes.json();
    assert(ownCodeRes.status === 400, 'Own code lookup returns 400');
    assert(
      ownCodeData.message === "That's your own friend code. Share it with a friend instead.",
      'Returns exact own code error message'
    );

    // 3d. Bad format code -> 400
    const badCodeRes = await fetch(`${baseUrl}/api/v1/users/by-code/INVALID`, {
      headers: { 'x-user-id': userAliceId, devicetype: 'ios' },
    });
    const badCodeData = await badCodeRes.json();
    assert(badCodeRes.status === 400, 'Bad code returns 400');
    assert(badCodeData.message === 'Friend codes are 8 letters and numbers', 'Returns bad format message');

    // 3e. Non-existent code -> 404
    const notFoundCodeRes = await fetch(`${baseUrl}/api/v1/users/by-code/ZZZZZZZZ`, {
      headers: { 'x-user-id': userAliceId, devicetype: 'ios' },
    });
    const notFoundCodeData = await notFoundCodeRes.json();
    assert(notFoundCodeRes.status === 404, 'Unknown code returns 404');
    assert(notFoundCodeData.message.includes('No player found with code'), 'Returns No player found error');

    // ----------------------------------------------------
    // TEST 4: Add Friend (POST /friends)
    // ----------------------------------------------------
    console.log('\n--- [TEST 4: Add Friend (POST /friends)] ---');
    // Alice connects socket to listen for friend:added if someone adds her
    const aliceSocket = createSocket(userAliceId);
    const bobSocket = createSocket(userBobId);

    await new Promise((resolve) => {
      let count = 0;
      const onConn = () => { count++; if (count === 2) resolve(); };
      aliceSocket.on('connect', onConn);
      bobSocket.on('connect', onConn);
    });

    let bobReceivedFriendAdded = null;
    bobSocket.once('friend:added', (evt) => {
      bobReceivedFriendAdded = evt;
    });

    // Alice adds Bob
    const addRes = await fetch(`${baseUrl}/api/v1/friends`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userAliceId,
        devicetype: 'ios',
      },
      body: JSON.stringify({
        friend_code: bobFriendCode,
      }),
    });
    const addData = await addRes.json();
    assert(addData.success === true, 'Alice added Bob successfully');
    assert(addData.data.friend.user_id === userBobId, 'Returned friend is Bob');
    assert(addData.data.friend.name === 'Sunny Otter', 'Friend name is Sunny Otter');

    await sleep(200);
    assert(bobReceivedFriendAdded?.friend?.user_id === userAliceId, 'Bob received real-time friend:added event');
    assert(bobReceivedFriendAdded?.friend?.name === 'Alice Wonder', 'friend:added contains Alice details');

    // 4b. Trying to add again -> 409
    const addAgainRes = await fetch(`${baseUrl}/api/v1/friends`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userAliceId,
        devicetype: 'ios',
      },
      body: JSON.stringify({
        friend_code: bobFriendCode,
      }),
    });
    const addAgainData = await addAgainRes.json();
    assert(addAgainRes.status === 409, 'Adding duplicate friend returns 409');
    assert(addAgainData.message === "You're already friends with Sunny Otter", 'Returns already friends message');

    // 4c. Trying to add self -> 400
    const addSelfRes = await fetch(`${baseUrl}/api/v1/friends`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userAliceId,
        devicetype: 'ios',
      },
      body: JSON.stringify({
        friend_code: aliceFriendCode,
      }),
    });
    const addSelfData = await addSelfRes.json();
    assert(addSelfRes.status === 400, 'Adding self returns 400');
    assert(
      addSelfData.message === "That's your own friend code. Share it with a friend instead.",
      'Returns own code message'
    );

    // ----------------------------------------------------
    // TEST 5: List Friends (GET /friends)
    // ----------------------------------------------------
    console.log('\n--- [TEST 5: List Friends (GET /friends)] ---');
    // Check Alice's friends
    const listAliceRes = await fetch(`${baseUrl}/api/v1/friends`, {
      headers: { 'x-user-id': userAliceId, devicetype: 'ios' },
    });
    const listAliceData = await listAliceRes.json();
    assert(listAliceData.success === true, 'List Alice friends succeeded');
    assert(listAliceData.data.friends.length === 1, 'Alice has exactly 1 friend');
    assert(listAliceData.data.friends[0].user_id === userBobId, 'Alice friend is Bob');
    assert(listAliceData.data.friends[0].is_online === true, 'Bob presence is online');
    assert(listAliceData.data.friends[0].status === 'online', 'Bob status is online');

    // Check Bob's friends (mutual add verification!)
    const listBobRes = await fetch(`${baseUrl}/api/v1/friends`, {
      headers: { 'x-user-id': userBobId, devicetype: 'ios' },
    });
    const listBobData = await listBobRes.json();
    assert(listBobData.success === true, 'List Bob friends succeeded');
    assert(listBobData.data.friends.length === 1, 'Bob has exactly 1 friend (mutual add verified)');
    assert(listBobData.data.friends[0].user_id === userAliceId, 'Bob friend is Alice');

    // ----------------------------------------------------
    // TEST 6: Socket Presence Broadcasts
    // ----------------------------------------------------
    console.log('\n--- [TEST 6: Socket Presence Broadcasts] ---');
    let presenceEventReceived = null;
    aliceSocket.on('friend:presence', (evt) => {
      presenceEventReceived = evt;
    });

    // Bob disconnects
    bobSocket.disconnect();
    // Wait for 5s grace period to fire
    await sleep(5500);

    assert(presenceEventReceived?.user_id === userBobId, 'Alice received presence update for Bob');
    assert(presenceEventReceived?.status === 'offline', 'Bob status shifted to offline');

    // ----------------------------------------------------
    // TEST 7: Game Invites Flow (Host invites Friend)
    // ----------------------------------------------------
    console.log('\n--- [TEST 7: Game Invites Flow] ---');
    // Bob reconnects
    const bobSocket2 = createSocket(userBobId);
    await new Promise((resolve) => bobSocket2.on('connect', resolve));
    await sleep(300);

    // Create a shoot game where Alice is Host
    const createShootRes = await fetch(`${baseUrl}/api/v1/shoot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userAliceId,
        devicetype: 'ios',
      },
      body: JSON.stringify({ name: 'Alice Wonder', profile_image: 'A9' }),
    });
    const createShootData = await createShootRes.json();
    const shootCode = createShootData.data.game.code;
    assert(!!shootCode, `Shoot game created with room code: ${shootCode}`);

    // Alice invites offline/unknown user -> Error
    const badInviteAck = await new Promise((resolve) => {
      aliceSocket.emit('invite:send', {
        to_user_id: userCharlieId,
        game: 'shoot',
        room_code: shootCode,
      }, resolve);
    });
    assert(badInviteAck?.ok === false && badInviteAck.code === 'NOT_FRIENDS',
      'Invite to non-friend rejected with NOT_FRIENDS');

    // Bob listens for invite:received
    let inviteReceivedEvt = null;
    bobSocket2.once('invite:received', (evt) => {
      inviteReceivedEvt = evt;
    });

    // Alice invites Bob
    const validInviteAck = await new Promise((resolve) => {
      aliceSocket.emit('invite:send', {
        to_user_id: userBobId,
        game: 'shoot',
        room_code: shootCode,
      }, resolve);
    });
    assert(validInviteAck?.ok === true, 'Invite send acked ok: true');
    assert(!!validInviteAck.invite_id, 'Invite has unique invite_id');
    const inviteId = validInviteAck.invite_id;

    await sleep(200);
    assert(inviteReceivedEvt?.invite_id === inviteId, 'Bob received invite:received with matching invite_id');
    assert(inviteReceivedEvt?.game === 'shoot', 'Invite specifies game shoot');
    assert(inviteReceivedEvt?.room_code === shootCode, 'Invite specifies room code');
    assert(inviteReceivedEvt?.from?.user_id === userAliceId, 'Invite specifies sender Alice');

    // Bob accepts invite
    let hostAcceptedEvt = null;
    aliceSocket.once('invite:accepted', (evt) => {
      hostAcceptedEvt = evt;
    });

    const respondAck = await new Promise((resolve) => {
      bobSocket2.emit('invite:respond', {
        invite_id: inviteId,
        accept: true,
      }, resolve);
    });
    assert(respondAck?.ok === true, 'Bob respond ack ok: true');
    await sleep(200);
    assert(hostAcceptedEvt?.invite_id === inviteId, 'Alice received invite:accepted');
    assert(hostAcceptedEvt?.by_user_id === userBobId, 'invite:accepted has by_user_id Bob');

    // Bob joins the shoot game with room_code via standard REST join
    const joinShootRes = await fetch(`${baseUrl}/api/v1/shoot/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userBobId,
        devicetype: 'ios',
      },
      body: JSON.stringify({ code: shootCode, name: 'Sunny Otter', profile_image: 'A4' }),
    });
    const joinShootData = await joinShootRes.json();
    assert(joinShootData.success === true, 'Bob joined shoot game via REST successfully');
    assert(joinShootData.data.game.status === 'playing', 'Shoot game transitioned to playing');

    // Responding again to already used invite -> INVITE_ENDED
    const reuseInviteAck = await new Promise((resolve) => {
      bobSocket2.emit('invite:respond', {
        invite_id: inviteId,
        accept: true,
      }, resolve);
    });
    assert(reuseInviteAck?.ok === false && reuseInviteAck.code === 'INVITE_ENDED',
      'Reusing answered invite returns INVITE_ENDED');

    // ----------------------------------------------------
    // TEST 8: Remove Friend (DELETE /friends/:user_id)
    // ----------------------------------------------------
    console.log('\n--- [TEST 8: Remove Friend (DELETE /friends/:user_id)] ---');
    let bobReceivedFriendRemoved = null;
    bobSocket2.once('friend:removed', (evt) => {
      bobReceivedFriendRemoved = evt;
    });

    const removeRes = await fetch(`${baseUrl}/api/v1/friends/${userBobId}`, {
      method: 'DELETE',
      headers: {
        'x-user-id': userAliceId,
        devicetype: 'ios',
      },
    });
    const removeData = await removeRes.json();
    assert(removeData.success === true, 'Alice removed Bob successfully');

    await sleep(200);
    assert(bobReceivedFriendRemoved?.user_id === userAliceId, 'Bob received friend:removed socket event');

    // Verify Bob is no longer in Alice's friend list
    const listAfterRes = await fetch(`${baseUrl}/api/v1/friends`, {
      headers: { 'x-user-id': userAliceId, devicetype: 'ios' },
    });
    const listAfterData = await listAfterRes.json();
    assert(listAfterData.data.friends.length === 0, 'Alice friend list is now empty');

    // Verify Alice is no longer in Bob's friend list
    const listBobAfterRes = await fetch(`${baseUrl}/api/v1/friends`, {
      headers: { 'x-user-id': userBobId, devicetype: 'ios' },
    });
    const listBobAfterData = await listBobAfterRes.json();
    assert(listBobAfterData.data.friends.length === 0, 'Bob friend list is now empty (mutual removal verified)');

    // Removing again returns success (idempotent)
    const removeAgainRes = await fetch(`${baseUrl}/api/v1/friends/${userBobId}`, {
      method: 'DELETE',
      headers: {
        'x-user-id': userAliceId,
        devicetype: 'ios',
      },
    });
    const removeAgainData = await removeAgainRes.json();
    assert(removeAgainData.success === true, 'Removing already-removed friend returns success');

    aliceSocket.disconnect();
    bobSocket2.disconnect();

    console.log('\n====================================================');
    console.log(`🎉 ALL FRIENDS & INVITES TESTS PASSED: ${passed}/${passed + failed}`);
    console.log('====================================================');
  } catch (err) {
    console.error('\n❌ TEST SUITE FAILED:', err);
    process.exit(1);
  } finally {
    server.close();
    await closePool();
  }
}

runTests();

