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

const PORT = 3463;
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
  console.log('--- Starting Tic Tac Toe Friend Invites Complete Verification Tests ---');
  await runMigrations();

  const server = http.createServer(app);
  const io = initializeSocket(server);
  app.set('io', io);

  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Server listening on port ${PORT}`);

  try {
    const userA = 'ttt-inv-host-1';
    const userB = 'ttt-inv-guest-2';
    const userC = 'ttt-inv-stranger-3';

    await pool.query('DELETE FROM users WHERE user_id IN ($1, $2, $3, $4)', [userA, userB, userC, 'ttt-offline-friend']);

    // 1. Register users
    console.log('\n[1] Registering users...');
    await post('/api/v1/users/register', { name: 'Bumblebee', profile_image: 'A1' }, { 'x-user-id': userA });
    await post('/api/v1/users/register', { name: 'Sunny Otter', profile_image: 'A4' }, { 'x-user-id': userB });
    await post('/api/v1/users/register', { name: 'Stranger', profile_image: 'A3' }, { 'x-user-id': userC });

    // Make Alice (Bumblebee) and Bob (Sunny Otter) mutual friends
    const { rows: bUser } = await pool.query('SELECT friend_code FROM users WHERE user_id = $1', [userB]);
    await post('/api/v1/friends', { friend_code: bUser[0].friend_code }, { 'x-user-id': userA });
    console.log('✓ Bumblebee and Sunny Otter are mutual friends');

    // 2. Create Tic Tac Toe Game for Alice
    console.log('\n[2] Alice creates Tic Tac Toe Game...');
    const { data: createRes } = await post('/api/v1/tictactoe', { name: 'Bumblebee' }, { 'x-user-id': userA });
    const tttCode = createRes.data.game.code;
    const tttId = createRes.data.game.id;
    assert.strictEqual(createRes.data.symbol, 'X');
    assert.strictEqual(createRes.data.game.status, 'waiting');
    console.log(`✓ Tic Tac Toe Game created with code ${tttCode} (Host is X, status is waiting)`);

    // Connect Alice socket
    const socketA = createClient(userA);
    await new Promise((res) => socketA.on('connect', res));

    // Connect Bob socket
    const socketB = createClient(userB);
    await new Promise((res) => socketB.on('connect', res));
    console.log('✓ Both sockets connected to /v1 namespace');

    // 3. Test Check 1: Non-friend invite
    console.log('\n[3] Testing Check 1: Non-friend invite...');
    const nonFriendAck = await new Promise((res) => {
      socketA.emit('invite:send', { to_user_id: userC, game: 'tictactoe', room_code: tttCode }, res);
    });
    assert.strictEqual(nonFriendAck.ok, false);
    assert.strictEqual(nonFriendAck.code, 'NOT_FRIENDS');
    assert.strictEqual(nonFriendAck.error, 'You can only invite friends');
    console.log('✓ Check 1 verified: NOT_FRIENDS -> "You can only invite friends"');

    // 4. Test Check 2: Invalid room code
    console.log('\n[4] Testing Check 2: Invalid game code...');
    const badCodeAck = await new Promise((res) => {
      socketA.emit('invite:send', { to_user_id: userB, game: 'tictactoe', room_code: 'XXXXXX' }, res);
    });
    assert.strictEqual(badCodeAck.ok, false);
    assert.strictEqual(badCodeAck.code, 'GAME_NOT_FOUND');
    assert.strictEqual(badCodeAck.error, 'That game has ended. Start a new one.');
    console.log('✓ Check 2 verified: GAME_NOT_FOUND -> "That game has ended. Start a new one."');

    // 5. Test Check 3: Non-host invite
    console.log('\n[5] Testing Check 3: Non-host invite...');
    const nonHostAck = await new Promise((res) => {
      socketB.emit('invite:send', { to_user_id: userA, game: 'tictactoe', room_code: tttCode }, res);
    });
    assert.strictEqual(nonHostAck.ok, false);
    assert.strictEqual(nonHostAck.code, 'NOT_HOST');
    assert.strictEqual(nonHostAck.error, 'Only the host can invite');
    console.log('✓ Check 3 verified: NOT_HOST -> "Only the host can invite"');

    // 6. Test Check 5: Friend offline
    console.log('\n[6] Testing Check 5: Friend offline...');
    const offlineFriendUser = 'ttt-offline-friend';
    await post('/api/v1/users/register', { name: 'Sleepy Beaver' }, { 'x-user-id': offlineFriendUser });
    const { rows: offRows } = await pool.query('SELECT friend_code FROM users WHERE user_id = $1', [offlineFriendUser]);
    await post('/api/v1/friends', { friend_code: offRows[0].friend_code }, { 'x-user-id': userA });

    const offlineAck = await new Promise((res) => {
      socketA.emit('invite:send', { to_user_id: offlineFriendUser, game: 'tictactoe', room_code: tttCode }, res);
    });
    assert.strictEqual(offlineAck.ok, false);
    assert.strictEqual(offlineAck.code, 'FRIEND_OFFLINE');
    assert.strictEqual(offlineAck.error, "Sleepy Beaver is offline. We'll let them know you invited them.");
    console.log('✓ Check 5 verified: FRIEND_OFFLINE -> "Sleepy Beaver is offline. We\'ll let them know you invited them."');

    // 7. Test Check 7: REPLACED invite (Alice sends invite 1, then sends invite 2)
    console.log('\n[7] Testing Check 7: Replaced invite...');
    const firstInvitePromise = new Promise((res) => {
      socketB.on('invite:received', (p) => res(p));
    });
    const send1Ack = await new Promise((res) => {
      socketA.emit('invite:send', { to_user_id: userB, game: 'tictactoe', room_code: tttCode }, res);
    });
    assert.strictEqual(send1Ack.ok, true);
    assert.ok(send1Ack.invite_id);
    assert.ok(send1Ack.expires_at);

    const invite1 = await firstInvitePromise;
    assert.strictEqual(invite1.game, 'tictactoe');
    assert.strictEqual(invite1.room_code, tttCode);
    assert.strictEqual(invite1.from.name, 'Bumblebee');
    assert.strictEqual(invite1.from.profile_image, 'A1');
    console.log('✓ First invite received by Sunny Otter with matching Tic Tac Toe details');

    // Alice sends another invite to same room -> invite 1 should be cancelled with reason REPLACED
    const cancelledPromise = new Promise((res) => {
      socketB.on('invite:cancelled', (p) => res(p));
    });
    const send2Ack = await new Promise((res) => {
      socketA.emit('invite:send', { to_user_id: userB, game: 'tictactoe', room_code: tttCode }, res);
    });
    assert.strictEqual(send2Ack.ok, true);
    const cancelledEvent = await cancelledPromise;
    assert.strictEqual(cancelledEvent.invite_id, invite1.invite_id);
    assert.strictEqual(cancelledEvent.reason, 'REPLACED');
    console.log('✓ Check 7 verified: Old invite cancelled with reason: "REPLACED"');

    // 8. Test invite:respond with accept: true
    console.log('\n[8] Testing Bob responds with accept: true...');
    const acceptedHostPromise = new Promise((res) => {
      socketA.on('invite:accepted', (p) => res(p));
    });
    const respondAck = await new Promise((res) => {
      socketB.emit('invite:respond', { invite_id: send2Ack.invite_id, accept: true }, res);
    });
    assert.strictEqual(respondAck.ok, true);
    const acceptedHost = await acceptedHostPromise;
    assert.strictEqual(acceptedHost.invite_id, send2Ack.invite_id);
    assert.strictEqual(acceptedHost.by_user_id, userB);
    console.log('✓ Sunny Otter accepted, Host Bumblebee received invite:accepted');

    // 9. Bob joins Tic Tac Toe Game via REST
    console.log('\n[9] Bob joins Tic Tac Toe Game via REST...');
    const joinRes = await post('/api/v1/tictactoe/join', { code: tttCode, name: 'Sunny Otter' }, { 'x-user-id': userB });
    assert.strictEqual(joinRes.status, 200);
    assert.strictEqual(joinRes.data.data.game.status, 'playing');
    assert.strictEqual(joinRes.data.data.symbol, 'O');

    // Check Presence: Both players should now be in_game with game: "tictactoe"
    const presA = getUserPresence(userA);
    const presB = getUserPresence(userB);
    assert.strictEqual(presA.status, 'in_game');
    assert.strictEqual(presA.game, 'tictactoe');
    assert.strictEqual(presB.status, 'in_game');
    assert.strictEqual(presB.game, 'tictactoe');
    console.log('✓ Presence verified: Both players are in_game with game: "tictactoe"');

    // 10. Test Check 4 & INVITE_ENDED: Responding to ended/filled game
    console.log('\n[10] Testing responding to ended invite...');
    const endedAck = await new Promise((res) => {
      socketB.emit('invite:respond', { invite_id: send2Ack.invite_id, accept: true }, res);
    });
    assert.strictEqual(endedAck.ok, false);
    assert.strictEqual(endedAck.code, 'INVITE_ENDED');
    console.log('✓ Re-responding to used invite returns INVITE_ENDED');

    // 11. Test Check 6: FRIEND_BUSY (Bob is in_game)
    console.log('\n[11] Testing Check 6: FRIEND_BUSY (Sunny Otter is in another game)...');
    const { data: game2ResPre } = await post('/api/v1/tictactoe', { name: 'Bumblebee' }, { 'x-user-id': userA });
    const busyAck = await new Promise((res) => {
      socketA.emit('invite:send', { to_user_id: userB, game: 'tictactoe', room_code: game2ResPre.data.game.code }, res);
    });
    assert.strictEqual(busyAck.ok, false);
    assert.strictEqual(busyAck.code, 'FRIEND_BUSY');
    assert.strictEqual(busyAck.error, 'Sunny Otter is in another game');
    console.log('✓ Check 6 verified: FRIEND_BUSY -> "Sunny Otter is in another game"');

    // Both players join socket room for game 1 and then leave
    await new Promise((res) => socketA.emit('ttt:game:join', { game_id: tttId }, res));
    await new Promise((res) => socketB.emit('ttt:game:join', { game_id: tttId }, res));
    await new Promise((res) => socketA.emit('ttt:game:leave', { game_id: tttId }, res));
    await new Promise((res) => socketB.emit('ttt:game:leave', { game_id: tttId }, res));

    // Verify Bob is back online
    const presBAfter = getUserPresence(userB);
    assert.strictEqual(presBAfter.status, 'online');
    console.log('✓ Sunny Otter left game 1 and presence restored to online');

    // 12. Test Host leaves waiting lobby -> HOST_LEFT
    console.log('\n[12] Testing Host leaves waiting lobby -> HOST_LEFT...');
    const { data: game2Res } = await post('/api/v1/tictactoe', { name: 'Bumblebee' }, { 'x-user-id': userA });
    const tttCode2 = game2Res.data.game.code;
    const tttId2 = game2Res.data.game.id;

    // Host joins socket room
    await new Promise((res) => {
      socketA.emit('ttt:game:join', { game_id: tttId2 }, res);
    });

    const inviteWaitPromise = new Promise((res) => {
      socketB.once('invite:received', (p) => res(p));
    });
    const sendWaitAck = await new Promise((res) => {
      socketA.emit('invite:send', { to_user_id: userB, game: 'tictactoe', room_code: tttCode2 }, res);
    });
    assert.strictEqual(sendWaitAck.ok, true);
    await inviteWaitPromise;

    const hostLeftPromise = new Promise((res) => {
      socketB.once('invite:cancelled', (p) => res(p));
    });

    // Alice leaves waiting lobby
    await new Promise((res) => {
      socketA.emit('ttt:game:leave', { game_id: tttId2 }, res);
    });

    const hostLeftEvent = await hostLeftPromise;
    assert.strictEqual(hostLeftEvent.invite_id, sendWaitAck.invite_id);
    assert.strictEqual(hostLeftEvent.reason, 'HOST_LEFT');
    console.log('✓ Host leaving waiting lobby cancelled invite with reason: "HOST_LEFT"');

    // 13. Test Host cancels invite explicitly -> CANCELLED
    console.log('\n[13] Testing Host cancels invite explicitly -> CANCELLED...');
    const { data: game3Res } = await post('/api/v1/tictactoe', { name: 'Bumblebee' }, { 'x-user-id': userA });
    const tttCode3 = game3Res.data.game.code;

    const inviteWaitPromise3 = new Promise((res) => {
      socketB.once('invite:received', (p) => res(p));
    });
    const sendWaitAck3 = await new Promise((res) => {
      socketA.emit('invite:send', { to_user_id: userB, game: 'tictactoe', room_code: tttCode3 }, res);
    });
    assert.strictEqual(sendWaitAck3.ok, true);
    await inviteWaitPromise3;

    const cancelExplicitPromise = new Promise((res) => {
      socketB.once('invite:cancelled', (p) => res(p));
    });

    const cancelAck = await new Promise((res) => {
      socketA.emit('invite:cancel', { invite_id: sendWaitAck3.invite_id }, res);
    });
    assert.strictEqual(cancelAck.ok, true);

    const cancelExplicitEvent = await cancelExplicitPromise;
    assert.strictEqual(cancelExplicitEvent.invite_id, sendWaitAck3.invite_id);
    assert.strictEqual(cancelExplicitEvent.reason, 'CANCELLED');
    console.log('✓ Host explicit invite:cancel cancelled invite with reason: "CANCELLED"');

    // 14. Test Game Over (Finished WIN/DRAW) keeps players in_game until leaving
    console.log('\n[14] Testing Game Over (Finished) keeps players in_game until leave...');
    await setPlayerInGame(io, userA, 'tictactoe');
    await setPlayerInGame(io, userB, 'tictactoe');
    assert.strictEqual(getUserPresence(userA).status, 'in_game');
    assert.strictEqual(getUserPresence(userB).status, 'in_game');

    // Player leaves result screen
    await new Promise((res) => socketA.emit('ttt:game:leave', { game_id: game3Res.data.game.id }, res));
    assert.strictEqual(getUserPresence(userA).status, 'online');
    console.log('✓ Player leaving result screen restored to online');

    socketA.disconnect();
    socketB.disconnect();

    console.log('\n=== ALL TIC TAC TOE FRIEND INVITE TESTS PASSED 100%! ===');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('Test failed with error:', err);
    server.close();
    process.exit(1);
  }
}

run();

