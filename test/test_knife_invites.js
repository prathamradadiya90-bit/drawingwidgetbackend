import assert from 'assert';
import http from 'http';
import { io as Client } from 'socket.io-client';
import app from '../src/app.js';
import { pool, closePool } from '../src/config/db.js';
import { runMigrations } from '../src/database/migrate.js';
import { initializeSocket } from '../src/sockets/index.js';
import {
  getUserPresence,
  setPlayerInGame,
} from '../src/services/friend.service.js';

const PORT = 3461;
const BASE_URL = `http://localhost:${PORT}`;

const userTokens = new Map();

function createClient(userId) {
  const token = userTokens.get(userId) || 'test';
  return Client(`${BASE_URL}/v1`, {
    query: { userId, token },
    auth: { userId, token },
    transports: ['websocket'],
    forceNew: true,
  });
}

function post(path, body, headers = {}) {
  const reqHeaders = { 'Content-Type': 'application/json', ...headers };
  const uid = reqHeaders['x-user-id'];
  if (uid && userTokens.has(uid) && !reqHeaders['x-auth-token']) {
    reqHeaders['x-auth-token'] = userTokens.get(uid);
  }
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify(body),
  }).then(async (r) => {
    const data = await r.json();
    if (path.includes('/register') && data?.data?.auth_token && uid) {
      userTokens.set(uid, data.data.auth_token);
    }
    return { status: r.status, data };
  });
}

function get(path, headers = {}) {
  const reqHeaders = { ...headers };
  const uid = reqHeaders['x-user-id'];
  if (uid && userTokens.has(uid) && !reqHeaders['x-auth-token']) {
    reqHeaders['x-auth-token'] = userTokens.get(uid);
  }
  return fetch(`${BASE_URL}${path}`, {
    headers: reqHeaders,
  }).then(async (r) => ({ status: r.status, data: await r.json() }));
}

async function run() {
  console.log('--- Starting Knife Hit Friend Invites Verification Tests ---');
  await runMigrations();

  const server = http.createServer(app);
  const io = initializeSocket(server);
  app.set('io', io);

  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Server listening on port ${PORT}`);

  try {
    const userA = 'knife-inv-host-1';
    const userB = 'knife-inv-guest-2';
    const userC = 'knife-inv-stranger-3';

    await pool.query('DELETE FROM users WHERE user_id IN ($1, $2, $3, $4)', [userA, userB, userC, 'knife-offline-friend']);

    // 1. Register users
    console.log('\n[1] Registering users...');
    await post('/api/v1/users/register', { name: 'HostAlice', profile_image: 'A1' }, { 'x-user-id': userA });
    await post('/api/v1/users/register', { name: 'Brave Fox', profile_image: 'A2' }, { 'x-user-id': userB });
    await post('/api/v1/users/register', { name: 'Stranger', profile_image: 'A3' }, { 'x-user-id': userC });

    // Make Alice and Bob mutual friends
    const { data: bobLookup } = await get(`/api/v1/users/by-code/`, { 'x-user-id': userA });
    const { rows: bUser } = await pool.query('SELECT friend_code FROM users WHERE user_id = $1', [userB]);
    await post('/api/v1/friends', { friend_code: bUser[0].friend_code }, { 'x-user-id': userA });
    console.log('✓ Alice and Bob are mutual friends');

    // 2. Create Knife Game for Alice
    console.log('\n[2] Alice creates Knife Game...');
    const { data: createRes } = await post('/api/v1/knife', { name: 'HostAlice' }, { 'x-user-id': userA });
    const knifeCode = createRes.data.game.code;
    const knifeId = createRes.data.game.id;
    console.log(`✓ Knife Game created with code ${knifeCode}`);

    // Connect Alice socket
    const socketA = createClient(userA);
    await new Promise((res) => socketA.on('connect', res));

    // Connect Bob socket
    const socketB = createClient(userB);
    await new Promise((res) => socketB.on('connect', res));
    console.log('✓ Both sockets connected');

    // 3. Test Check 1: Non-friend invite
    console.log('\n[3] Testing Check 1: Non-friend invite...');
    const nonFriendAck = await new Promise((res) => {
      socketA.emit('invite:send', { to_user_id: userC, game: 'knife', room_code: knifeCode }, res);
    });
    assert.strictEqual(nonFriendAck.ok, false);
    assert.strictEqual(nonFriendAck.code, 'NOT_FRIENDS');
    assert.strictEqual(nonFriendAck.error, 'You can only invite friends');
    console.log('✓ Check 1 verified: NOT_FRIENDS -> "You can only invite friends"');

    // 4. Test Check 2: Invalid room code
    console.log('\n[4] Testing Check 2: Invalid game code...');
    const badCodeAck = await new Promise((res) => {
      socketA.emit('invite:send', { to_user_id: userB, game: 'knife', room_code: 'XXXXXX' }, res);
    });
    assert.strictEqual(badCodeAck.ok, false);
    assert.strictEqual(badCodeAck.code, 'GAME_NOT_FOUND');
    assert.strictEqual(badCodeAck.error, 'That game has ended. Start a new one.');
    console.log('✓ Check 2 verified: GAME_NOT_FOUND -> "That game has ended. Start a new one."');

    // 5. Test Check 3: Non-host invite
    console.log('\n[5] Testing Check 3: Non-host invite...');
    const nonHostAck = await new Promise((res) => {
      socketB.emit('invite:send', { to_user_id: userA, game: 'knife', room_code: knifeCode }, res);
    });
    assert.strictEqual(nonHostAck.ok, false);
    assert.strictEqual(nonHostAck.code, 'NOT_HOST');
    assert.strictEqual(nonHostAck.error, 'Only the host can invite');
    console.log('✓ Check 3 verified: NOT_HOST -> "Only the host can invite"');

    // 6. Test Check 5: Friend offline
    console.log('\n[6] Testing Check 5: Friend offline...');
    socketB.disconnect();
    // Simulate offline presence directly
    const { rows: bRows } = await pool.query('SELECT name FROM users WHERE user_id = $1', [userB]);
    const bName = bRows[0].name; // 'Brave Fox'

    // Temporarily wait or trigger disconnect
    await new Promise((r) => setTimeout(r, 200));
    // Re-verify with a mock offline user
    const offlineFriendUser = 'knife-offline-friend';
    await post('/api/v1/users/register', { name: 'Sleepy Bear' }, { 'x-user-id': offlineFriendUser });
    const { rows: offRows } = await pool.query('SELECT friend_code FROM users WHERE user_id = $1', [offlineFriendUser]);
    await post('/api/v1/friends', { friend_code: offRows[0].friend_code }, { 'x-user-id': userA });

    const offlineAck = await new Promise((res) => {
      socketA.emit('invite:send', { to_user_id: offlineFriendUser, game: 'knife', room_code: knifeCode }, res);
    });
    assert.strictEqual(offlineAck.ok, false);
    assert.strictEqual(offlineAck.code, 'FRIEND_OFFLINE');
    assert.strictEqual(offlineAck.error, "Sleepy Bear is offline. We'll let them know you invited them.");
    console.log('✓ Check 5 verified: FRIEND_OFFLINE -> "Sleepy Bear is offline. We\'ll let them know you invited them."');

    // Reconnect Bob
    const socketB2 = createClient(userB);
    await new Promise((res) => socketB2.on('connect', res));

    // 7. Test Check 7: REPLACED invite
    console.log('\n[7] Testing Check 7: Replaced invite...');
    const firstInvitePromise = new Promise((res) => {
      socketB2.on('invite:received', (p) => res(p));
    });
    const send1Ack = await new Promise((res) => {
      socketA.emit('invite:send', { to_user_id: userB, game: 'knife', room_code: knifeCode }, res);
    });
    assert.strictEqual(send1Ack.ok, true);
    const invite1 = await firstInvitePromise;
    assert.strictEqual(invite1.game, 'knife');
    assert.strictEqual(invite1.room_code, knifeCode);
    console.log('✓ First invite received by Bob');

    // Alice sends another invite to same room -> invite 1 should be cancelled with REPLACED
    const cancelledPromise = new Promise((res) => {
      socketB2.on('invite:cancelled', (p) => res(p));
    });
    const send2Ack = await new Promise((res) => {
      socketA.emit('invite:send', { to_user_id: userB, game: 'knife', room_code: knifeCode }, res);
    });
    assert.strictEqual(send2Ack.ok, true);
    const cancelledEvent = await cancelledPromise;
    assert.strictEqual(cancelledEvent.invite_id, invite1.invite_id);
    assert.strictEqual(cancelledEvent.reason, 'REPLACED');
    console.log('✓ Check 7 verified: Old invite cancelled with reason: "REPLACED"');

    // 8. Test invite:respond accept
    console.log('\n[8] Testing Bob responds with accept: true...');
    const acceptedHostPromise = new Promise((res) => {
      socketA.on('invite:accepted', (p) => res(p));
    });
    const respondAck = await new Promise((res) => {
      socketB2.emit('invite:respond', { invite_id: send2Ack.invite_id, accept: true }, res);
    });
    assert.strictEqual(respondAck.ok, true);
    const acceptedHost = await acceptedHostPromise;
    assert.strictEqual(acceptedHost.invite_id, send2Ack.invite_id);
    assert.strictEqual(acceptedHost.by_user_id, userB);
    console.log('✓ Bob accepted, Host received invite:accepted');

    // 9. Bob joins Knife Game via REST
    console.log('\n[9] Bob joins Knife Game via REST...');
    const joinRes = await post('/api/v1/knife/join', { code: knifeCode, name: 'Brave Fox' }, { 'x-user-id': userB });
    assert.strictEqual(joinRes.status, 200);
    assert.strictEqual(joinRes.data.data.game.status, 'playing');

    // Check Presence: Both players should now be in_game with game: "knife"
    const presA = getUserPresence(userA);
    const presB = getUserPresence(userB);
    assert.strictEqual(presA.status, 'in_game');
    assert.strictEqual(presA.game, 'knife');
    assert.strictEqual(presB.status, 'in_game');
    assert.strictEqual(presB.game, 'knife');
    console.log('✓ Presence verified: Both players are in_game with game: "knife"');

    // 10. Test Check 4 & INVITE_ENDED: Responding to ended/filled game
    console.log('\n[10] Testing responding to ended invite...');
    const endedAck = await new Promise((res) => {
      socketB2.emit('invite:respond', { invite_id: send2Ack.invite_id, accept: true }, res);
    });
    assert.strictEqual(endedAck.ok, false);
    assert.strictEqual(endedAck.code, 'INVITE_ENDED');
    console.log('✓ Re-responding to used invite returns INVITE_ENDED');

    // 10.5 Test Check 6: FRIEND_BUSY (Bob is in_game)
    console.log('\n[10.5] Testing Check 6: FRIEND_BUSY...');
    const { data: game2ResPre } = await post('/api/v1/knife', { name: 'HostAlice' }, { 'x-user-id': userA });
    const busyAck = await new Promise((res) => {
      socketA.emit('invite:send', { to_user_id: userB, game: 'knife', room_code: game2ResPre.data.game.code }, res);
    });
    assert.strictEqual(busyAck.ok, false);
    assert.strictEqual(busyAck.code, 'FRIEND_BUSY');
    assert.strictEqual(busyAck.error, 'Brave Fox is in another game');
    console.log('✓ Check 6 verified: FRIEND_BUSY -> "Brave Fox is in another game"');

    // Both players leave game 1
    // Join Bob into socket room first then leave
    await new Promise((res) => socketB2.emit('knife:game:join', { game_id: knifeId }, res));
    await new Promise((res) => socketA.emit('knife:game:leave', { game_id: knifeId }, res));
    await new Promise((res) => socketB2.emit('knife:game:leave', { game_id: knifeId }, res));

    // Verify Bob is back online
    const presBAfter = getUserPresence(userB);
    assert.strictEqual(presBAfter.status, 'online');
    console.log('✓ Bob left game 1 and is back online');

    // 11. Test Host leaves waiting lobby -> HOST_LEFT
    console.log('\n[11] Testing Host leaves waiting lobby -> HOST_LEFT...');
    const { data: game2Res } = await post('/api/v1/knife', { name: 'HostAlice' }, { 'x-user-id': userA });
    const knifeCode2 = game2Res.data.game.code;
    const knifeId2 = game2Res.data.game.id;

    // Join socket room
    const joinAck = await new Promise((res) => {
      socketA.emit('knife:game:join', { game_id: knifeId2 }, res);
    });
    console.log('Joined game 2:', joinAck);

    const inviteWaitPromise = new Promise((res) => {
      socketB2.once('invite:received', (p) => res(p));
    });
    const sendWaitAck = await new Promise((res) => {
      socketA.emit('invite:send', { to_user_id: userB, game: 'knife', room_code: knifeCode2 }, res);
    });
    console.log('Sent wait invite:', sendWaitAck);
    assert.strictEqual(sendWaitAck.ok, true);
    await inviteWaitPromise;

    const hostLeftPromise = new Promise((res) => {
      socketB2.once('invite:cancelled', (p) => res(p));
    });

    // Alice leaves waiting lobby
    const leaveAck = await new Promise((res) => {
      socketA.emit('knife:game:leave', { game_id: knifeId2 }, res);
    });
    console.log('Left lobby ack:', leaveAck);

    const hostLeftEvent = await hostLeftPromise;
    console.log('Host left event:', hostLeftEvent);
    assert.strictEqual(hostLeftEvent.invite_id, sendWaitAck.invite_id);
    assert.strictEqual(hostLeftEvent.reason, 'HOST_LEFT');
    console.log('✓ Host leaving waiting lobby cancelled invite with reason: "HOST_LEFT"');

    socketA.disconnect();
    socketB2.disconnect();

    console.log('\n=== ALL KNIFE HIT FRIEND INVITE TESTS PASSED 100%! ===');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('Test failed with error:', err);
    server.close();
    process.exit(1);
  }
}

run();
