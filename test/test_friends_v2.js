import http from 'http';
import { io as Client } from 'socket.io-client';
import app from '../src/app.js';
import { pool, closePool } from '../src/config/db.js';
import { runMigrations } from '../src/database/migrate.js';
import { initializeSocket } from '../src/sockets/index.js';
import { friendRequestService } from '../src/services/friend_request.service.js';
import { getUserPresence } from '../src/services/friend.service.js';

const TEST_PORT = 3470;
const server = http.createServer(app);
const io = initializeSocket(server);
app.set('io', io);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createSocket(userId, token = null) {
  return Client(`http://localhost:${TEST_PORT}/v1`, {
    transports: ['websocket'],
    forceNew: true,
    auth: {
      userId,
      token,
      devicetype: 'ios',
    },
  });
}

async function runTests() {
  console.log('====================================================');
  console.log('   STARTING FRIENDS V2 COMPREHENSIVE TEST SUITE     ');
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
    const userA = 'v2-user-alice-001';
    const userB = 'v2-user-bob-002';
    const userC = 'v2-user-charlie-003';
    const userD = 'v2-user-dave-legacy-004';

    // Clean up any test users from prior runs
    await pool.query('DELETE FROM users WHERE user_id IN ($1, $2, $3, $4)', [userA, userB, userC, userD]);

    // ----------------------------------------------------
    // 1. DEVICE TOKEN TESTS
    // ----------------------------------------------------
    console.log('\n--- [1. DEVICE TOKEN TESTS] ---');

    // 1.1 New user A registers -> returns auth_token
    const regARes = await fetch(`${baseUrl}/api/v1/users/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userA },
      body: JSON.stringify({ name: 'Alice', profile_image: 'A1' }),
    });
    const regAData = await regARes.json();
    assert(regAData.success === true, 'User A registered successfully');
    assert(typeof regAData.data.auth_token === 'string' && regAData.data.auth_token.length >= 32, 'User A received 32+ byte auth_token');
    const tokenA = regAData.data.auth_token;
    const codeA = regAData.data.friend_code;

    // 1.2 Second register with auth_token -> returns NO auth_token
    const regA2Res = await fetch(`${baseUrl}/api/v1/users/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userA,
        'x-auth-token': tokenA,
      },
      body: JSON.stringify({ name: 'Alice Wonder', profile_image: 'A2' }),
    });
    const regA2Data = await regA2Res.json();
    assert(regA2Data.success === true, 'User A re-register with token succeeded');
    assert(regA2Data.data.auth_token === undefined, 'Second register returned NO auth_token');
    assert(regA2Data.data.friend_code === codeA, 'Friend code remained identical');

    // 1.3 User A calls REST with WRONG x-auth-token -> 401
    const badTokenRes = await fetch(`${baseUrl}/api/v1/friends`, {
      headers: { 'x-user-id': userA, 'x-auth-token': 'wrong-token-value' },
    });
    assert(badTokenRes.status === 401, 'Wrong x-auth-token returned 401');
    const badTokenData = await badTokenRes.json();
    assert(badTokenData.message === 'Your session is no longer valid. Reinstall the app or contact support.', 'Exact 401 error message returned');

    // 1.4 User A calls REST with MISSING x-auth-token -> 401
    const missingTokenRes = await fetch(`${baseUrl}/api/v1/friends`, {
      headers: { 'x-user-id': userA },
    });
    assert(missingTokenRes.status === 401, 'Missing x-auth-token returned 401 for user with token');

    // 1.5 Socket connect with WRONG token -> connect_error Unauthorized: invalid token
    const badSocket = createSocket(userA, 'bad-secret');
    const socketErrorMsg = await new Promise((resolve) => {
      badSocket.on('connect_error', (err) => resolve(err.message));
    });
    assert(socketErrorMsg.includes('Unauthorized: invalid token'), 'Socket with wrong token received Unauthorized: invalid token');
    badSocket.close();

    // 1.6 Socket connect with CORRECT token -> connects successfully
    const socketA = createSocket(userA, tokenA);
    await new Promise((resolve) => socketA.on('connect', resolve));
    assert(socketA.connected === true, 'Socket with valid token connected successfully');

    // 1.7 Existing user without token in DB (legacy migration test)
    await pool.query(
      `INSERT INTO users (user_id, friend_code, name, profile_image, auth_token_hash)
       VALUES ($1, 'LEGACY01', 'Dave', 'A4', NULL)`,
      [userD]
    );
    // Dave calls without token -> allowed (until REQUIRE_AUTH_TOKEN is on)
    const legacyGetRes = await fetch(`${baseUrl}/api/v1/friends`, {
      headers: { 'x-user-id': userD },
    });
    assert(legacyGetRes.status === 200, 'Legacy user without token allowed before REQUIRE_AUTH_TOKEN');

    // Dave registers -> claims auth_token
    const legacyRegRes = await fetch(`${baseUrl}/api/v1/users/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userD },
      body: JSON.stringify({ name: 'Dave' }),
    });
    const legacyRegData = await legacyRegRes.json();
    assert(legacyRegData.success === true, 'Legacy user register succeeded');
    assert(typeof legacyRegData.data.auth_token === 'string', 'Legacy user received initial auth_token on register');
    const tokenD = legacyRegData.data.auth_token;

    // Now Dave has a token; calling without token gets 401
    const legacyWithoutTokenRes = await fetch(`${baseUrl}/api/v1/friends`, {
      headers: { 'x-user-id': userD },
    });
    assert(legacyWithoutTokenRes.status === 401, 'Legacy user now requires token after claiming');

    // Register User B
    const regBRes = await fetch(`${baseUrl}/api/v1/users/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userB },
      body: JSON.stringify({ name: 'Sunny Otter', profile_image: 'A4' }),
    });
    const regBData = await regBRes.json();
    const tokenB = regBData.data.auth_token;
    const codeB = regBData.data.friend_code;

    // Connect Bob socket
    const socketB = createSocket(userB, tokenB);
    await new Promise((resolve) => socketB.on('connect', resolve));
    assert(socketB.connected === true, 'Bob socket connected');

    // Register User C
    const regCRes = await fetch(`${baseUrl}/api/v1/users/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userC },
      body: JSON.stringify({ name: 'Charlie Fox', profile_image: 'A5' }),
    });
    const regCData = await regCRes.json();
    const tokenC = regCData.data.auth_token;

    // ----------------------------------------------------
    // 2. FRIEND REQUESTS LIFECYCLE (Section 3)
    // ----------------------------------------------------
    console.log('\n--- [2. FRIEND REQUESTS LIFECYCLE] ---');

    // 2.1 A sends B a request by code
    let bobReceivedRequest = null;
    let bobReceivedNotification = null;
    socketB.once('friend:request:received', (evt) => {
      bobReceivedRequest = evt;
    });
    socketB.once('notification:new', (evt) => {
      bobReceivedNotification = evt;
    });

    const sendReqRes = await fetch(`${baseUrl}/api/v1/friend-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userA,
        'x-auth-token': tokenA,
      },
      body: JSON.stringify({ friend_code: codeB }),
    });
    assert(sendReqRes.status === 201, 'Send request by code returned 201');
    const sendReqData = await sendReqRes.json();
    const req1 = sendReqData.data.request;
    assert(req1.from.user_id === userA, 'Request from is Alice');
    assert(req1.to.user_id === userB, 'Request to is Bob');
    assert(req1.source === 'code', 'Request source is code');
    assert(req1.game === null, 'Request game is null');

    await sleep(200);
    assert(bobReceivedRequest !== null, 'Bob received friend:request:received socket event');
    assert(bobReceivedRequest.request.request_id === req1.request_id, 'Socket event matches request_id');
    assert(bobReceivedNotification !== null, 'Bob received notification:new socket event');
    assert(bobReceivedNotification.notification.type === 'friend_request', 'Notification type is friend_request');

    // 2.2 List open requests (GET /friend-requests)
    // Bob lists requests: req1 under incoming
    const bobReqsRes = await fetch(`${baseUrl}/api/v1/friend-requests`, {
      headers: { 'x-user-id': userB, 'x-auth-token': tokenB },
    });
    const bobReqsData = await bobReqsRes.json();
    assert(bobReqsData.data.incoming.length === 1, 'Bob incoming requests count is 1');
    assert(bobReqsData.data.incoming[0].request_id === req1.request_id, 'Bob incoming request matches req1');
    assert(bobReqsData.data.outgoing.length === 0, 'Bob outgoing requests count is 0');

    // Alice lists requests: req1 under outgoing
    const aliceReqsRes = await fetch(`${baseUrl}/api/v1/friend-requests`, {
      headers: { 'x-user-id': userA, 'x-auth-token': tokenA },
    });
    const aliceReqsData = await aliceReqsRes.json();
    assert(aliceReqsData.data.outgoing.length === 1, 'Alice outgoing requests count is 1');
    assert(aliceReqsData.data.outgoing[0].request_id === req1.request_id, 'Alice outgoing matches req1');

    // 2.3 Duplicate request: A sends again to B -> 409
    const dupReqRes = await fetch(`${baseUrl}/api/v1/friend-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userA,
        'x-auth-token': tokenA,
      },
      body: JSON.stringify({ friend_code: codeB }),
    });
    assert(dupReqRes.status === 409, 'Duplicate request returned 409');
    const dupReqData = await dupReqRes.json();
    assert(dupReqData.message === 'You already sent Sunny Otter a request', 'Duplicate request error message matches');

    // 2.4 B accepts req1
    let aliceReceivedAccepted = null;
    let bobReceivedNotifRemoved = null;
    socketA.once('friend:request:accepted', (evt) => {
      aliceReceivedAccepted = evt;
    });
    socketB.once('notification:removed', (evt) => {
      bobReceivedNotifRemoved = evt;
    });

    const acceptRes = await fetch(`${baseUrl}/api/v1/friend-requests/${req1.request_id}/accept`, {
      method: 'POST',
      headers: { 'x-user-id': userB, 'x-auth-token': tokenB },
    });
    assert(acceptRes.status === 200, 'Accept request returned 200');
    const acceptData = await acceptRes.json();
    assert(acceptData.data.friend.user_id === userA, 'Accept returned Alice as Friend');
    assert(acceptData.data.friend.is_online === true, 'Alice friend presence is online');

    await sleep(200);
    assert(aliceReceivedAccepted !== null, 'Alice received friend:request:accepted');
    assert(aliceReceivedAccepted.friend.user_id === userB, 'Accepted event returned Bob as Friend');
    assert(bobReceivedNotifRemoved !== null, 'Bob received notification:removed');

    // Both are on each other's GET /friends
    const listFriendsA = await fetch(`${baseUrl}/api/v1/friends`, {
      headers: { 'x-user-id': userA, 'x-auth-token': tokenA },
    }).then((r) => r.json());
    assert(listFriendsA.data.friends.some((f) => f.user_id === userB), 'Bob is on Alice friend list');

    const listFriendsB = await fetch(`${baseUrl}/api/v1/friends`, {
      headers: { 'x-user-id': userB, 'x-auth-token': tokenB },
    }).then((r) => r.json());
    assert(listFriendsB.data.friends.some((f) => f.user_id === userA), 'Alice is on Bob friend list');

    // Check 4: Trying to send request when already friends -> 409
    const alreadyFriendsRes = await fetch(`${baseUrl}/api/v1/friend-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userA,
        'x-auth-token': tokenA,
      },
      body: JSON.stringify({ friend_code: codeB }),
    });
    assert(alreadyFriendsRes.status === 409, 'Request to existing friend returned 409');
    const alreadyFriendsData = await alreadyFriendsRes.json();
    assert(alreadyFriendsData.message === 'You\'re already friends with Sunny Otter', 'Already friends message verified');

    // Remove friendship to test Decline and Cancel flows
    await fetch(`${baseUrl}/api/v1/friends/${userB}`, {
      method: 'DELETE',
      headers: { 'x-user-id': userA, 'x-auth-token': tokenA },
    });

    // ----------------------------------------------------
    // 2.5 DECLINE & 24H COOLDOWN
    // ----------------------------------------------------
    console.log('\n--- [2.5 DECLINE & COOLDOWN TESTS] ---');
    // A sends B a new request
    const req2Res = await fetch(`${baseUrl}/api/v1/friend-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userA,
        'x-auth-token': tokenA,
      },
      body: JSON.stringify({ friend_code: codeB }),
    });
    const req2Id = (await req2Res.json()).data.request.request_id;

    let aliceReceivedDeclined = null;
    socketA.once('friend:request:ended', (evt) => {
      aliceReceivedDeclined = evt;
    });

    // B declines
    const declineRes = await fetch(`${baseUrl}/api/v1/friend-requests/${req2Id}/decline`, {
      method: 'POST',
      headers: { 'x-user-id': userB, 'x-auth-token': tokenB },
    });
    assert(declineRes.status === 200, 'Decline returned 200');
    await sleep(200);
    assert(aliceReceivedDeclined !== null, 'Alice received friend:request:ended');
    assert(aliceReceivedDeclined.reason === 'DECLINED', 'Reason is DECLINED');

    // A tries to send to B again immediately -> 429
    const cooldownRes = await fetch(`${baseUrl}/api/v1/friend-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userA,
        'x-auth-token': tokenA,
      },
      body: JSON.stringify({ friend_code: codeB }),
    });
    assert(cooldownRes.status === 429, 'Request within 24h of decline returned 429');
    const cooldownData = await cooldownRes.json();
    assert(cooldownData.message === 'You can send Sunny Otter another request later', 'Declined cooldown message matches');

    // ----------------------------------------------------
    // 2.6 CANCEL FLOW
    // ----------------------------------------------------
    console.log('\n--- [2.6 CANCEL FLOW] ---');
    // Reset declined cooldown in DB for testing
    await pool.query('DELETE FROM friend_requests WHERE from_user_id = $1 AND to_user_id = $2', [userA, userB]);

    // A sends B a request
    const req3Res = await fetch(`${baseUrl}/api/v1/friend-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userA,
        'x-auth-token': tokenA,
      },
      body: JSON.stringify({ friend_code: codeB }),
    });
    const req3Id = (await req3Res.json()).data.request.request_id;

    let bobReceivedCancelled = null;
    socketB.once('friend:request:ended', (evt) => {
      bobReceivedCancelled = evt;
    });

    // A cancels
    const cancelRes = await fetch(`${baseUrl}/api/v1/friend-requests/${req3Id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': userA, 'x-auth-token': tokenA },
    });
    assert(cancelRes.status === 200, 'Cancel request returned 200');
    await sleep(200);
    assert(bobReceivedCancelled !== null, 'Bob received friend:request:ended');
    assert(bobReceivedCancelled.reason === 'CANCELLED', 'Reason is CANCELLED');

    // Accepting a cancelled request -> 410
    const acceptCancelledRes = await fetch(`${baseUrl}/api/v1/friend-requests/${req3Id}/accept`, {
      method: 'POST',
      headers: { 'x-user-id': userB, 'x-auth-token': tokenB },
    });
    assert(acceptCancelledRes.status === 410, 'Accepting cancelled request returned 410');

    // ----------------------------------------------------
    // 2.7 AUTO-ACCEPT (MUTUAL REQUEST)
    // ----------------------------------------------------
    console.log('\n--- [2.7 AUTO-ACCEPT (MUTUAL REQUEST)] ---');
    // B sends A a request
    const reqBtoARes = await fetch(`${baseUrl}/api/v1/friend-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userB,
        'x-auth-token': tokenB,
      },
      body: JSON.stringify({ friend_code: codeA }),
    });
    assert(reqBtoARes.status === 201, 'B sent request to A successfully');

    let bReceivedAutoAccepted = null;
    socketB.once('friend:request:accepted', (evt) => {
      bReceivedAutoAccepted = evt;
    });

    // A sends B a request while B's request is pending -> Auto-accept!
    const autoAcceptRes = await fetch(`${baseUrl}/api/v1/friend-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userA,
        'x-auth-token': tokenA,
      },
      body: JSON.stringify({ friend_code: codeB }),
    });
    assert(autoAcceptRes.status === 200, 'Auto-accept returned 200');
    const autoAcceptData = await autoAcceptRes.json();
    assert(autoAcceptData.data.auto_accepted === true, 'Response contains auto_accepted: true');
    assert(autoAcceptData.data.friend.user_id === userB, 'Response contains Bob as Friend');

    await sleep(200);
    assert(bReceivedAutoAccepted !== null, 'Bob received friend:request:accepted socket event');
    assert(bReceivedAutoAccepted.friend.user_id === userA, 'Bob accepted payload contains Alice');

    // Clean up friendship
    await fetch(`${baseUrl}/api/v1/friends/${userB}`, {
      method: 'DELETE',
      headers: { 'x-user-id': userA, 'x-auth-token': tokenA },
    });

    // ----------------------------------------------------
    // 2.8 MATCH POP-UP ADD (user_id body + 24h played together check)
    // ----------------------------------------------------
    console.log('\n--- [2.8 MATCH POP-UP ADD] ---');
    // A tries to add C by user_id WITHOUT having played together -> 403
    const noMatchRes = await fetch(`${baseUrl}/api/v1/friend-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userA,
        'x-auth-token': tokenA,
      },
      body: JSON.stringify({ user_id: userC, game: 'shoot' }),
    });
    assert(noMatchRes.status === 403, 'Adding stranger by user_id returned 403');
    const noMatchData = await noMatchRes.json();
    assert(noMatchData.message === 'You can only add players you just played with', 'Match requirement message matches');

    // Simulate match between A and C in shoot_games/shoot_players
    const { rows: gRows } = await pool.query(
      `INSERT INTO shoot_games (code, host_id, status, created_at)
       VALUES ('MATCH1', $1, 'finished', NOW()) RETURNING id`,
      [userA]
    );
    const gameId = gRows[0].id;
    await pool.query(
      `INSERT INTO shoot_players (game_id, user_id, color, name)
       VALUES ($1, $2, 'blue', 'Alice'), ($1, $3, 'red', 'Charlie')`,
      [gameId, userA, userC]
    );

    // Now A sends request by user_id to C -> 201
    const matchAddRes = await fetch(`${baseUrl}/api/v1/friend-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userA,
        'x-auth-token': tokenA,
      },
      body: JSON.stringify({ user_id: userC, game: 'shoot' }),
    });
    assert(matchAddRes.status === 201, 'Adding opponent after match returned 201');
    const matchAddData = await matchAddRes.json();
    assert(matchAddData.data.request.source === 'match', 'Request source is match');
    assert(matchAddData.data.request.game === 'shoot', 'Request game is shoot');

    // ----------------------------------------------------
    // 2.9 EXPIRATION JOB
    // ----------------------------------------------------
    console.log('\n--- [2.9 EXPIRATION JOB] ---');
    const matchReqId = matchAddData.data.request.request_id;
    // Set expires_at in the past
    await pool.query("UPDATE friend_requests SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [matchReqId]);

    // Connect socket for Charlie
    const socketC = createSocket(userC, tokenC);
    await new Promise((res) => socketC.on('connect', res));

    let aExpiredEvt = null;
    let cExpiredEvt = null;
    socketA.once('friend:request:ended', (evt) => { aExpiredEvt = evt; });
    socketC.once('friend:request:ended', (evt) => { cExpiredEvt = evt; });

    // Run expiration sweep
    const sweepResult = await friendRequestService.sweepExpiredRequests(io);
    assert(sweepResult.expiredCount >= 1, 'Sweep expired at least 1 request');

    await sleep(200);
    assert(aExpiredEvt !== null && aExpiredEvt.reason === 'EXPIRED', 'Alice received friend:request:ended EXPIRED');
    assert(cExpiredEvt !== null && cExpiredEvt.reason === 'EXPIRED', 'Charlie received friend:request:ended EXPIRED');

    // ----------------------------------------------------
    // 3. GAME INVITES & NOTIFICATIONS (Section 4 & 5)
    // ----------------------------------------------------
    console.log('\n--- [3. GAME INVITES & NOTIFICATIONS] ---');

    // Make Alice and Bob mutual friends for game invites
    const userA_least = userA < userB ? userA : userB;
    const userB_greatest = userA < userB ? userB : userA;
    await pool.query(
      `INSERT INTO friendships (user_a, user_b, created_by, created_at)
       VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING`,
      [userA_least, userB_greatest, userA]
    );

    // Create a knife game for Alice
    const { rows: knifeRows } = await pool.query(
      `INSERT INTO knife_games (code, host_id, status, created_at)
       VALUES ('KNIFE1', $1, 'waiting', NOW()) RETURNING id, code`,
      [userA]
    );
    const knifeCode = knifeRows[0].code;

    // Disconnect Bob socket so Bob is OFFLINE
    socketB.disconnect();
    await sleep(100);

    // Alice sends invite to offline Bob
    let inviteAck = null;
    await new Promise((resolve) => {
      socketA.emit('invite:send', { to_user_id: userB, game: 'knife', room_code: knifeCode }, (ack) => {
        inviteAck = ack;
        resolve();
      });
    });

    assert(inviteAck.ok === false, 'Invite send to offline friend acked ok: false');
    assert(inviteAck.code === 'FRIEND_OFFLINE', 'Code is FRIEND_OFFLINE');
    assert(
      inviteAck.error.includes("Sunny Otter is offline. We'll let them know you invited them."),
      'Ack contains new offline message'
    );

    // Bob's GET /notifications shows missed_invite with reason: OFFLINE
    const notifsRes = await fetch(`${baseUrl}/api/v1/notifications`, {
      headers: { 'x-user-id': userB, 'x-auth-token': tokenB },
    });
    const notifsData = await notifsRes.json();
    assert(notifsData.data.notifications.length === 1, 'Bob has 1 missed invite notification');
    const firstNotif = notifsData.data.notifications[0];
    assert(firstNotif.type === 'missed_invite', 'Notification type is missed_invite');
    assert(firstNotif.invite.game === 'knife', 'Notification game is knife');
    assert(firstNotif.invite.reason === 'OFFLINE', 'Notification reason is OFFLINE');
    assert(firstNotif.invite.from.user_id === userA, 'Notification from is Alice');
    const firstNotifId = firstNotif.notification_id;

    // Deduplication check: Alice invites again within 30 minutes
    await new Promise((resolve) => {
      socketA.emit('invite:send', { to_user_id: userB, game: 'knife', room_code: knifeCode }, (ack) => {
        resolve();
      });
    });

    const notifsDedupRes = await fetch(`${baseUrl}/api/v1/notifications`, {
      headers: { 'x-user-id': userB, 'x-auth-token': tokenB },
    }).then((r) => r.json());
    assert(notifsDedupRes.data.notifications.length === 1, 'Still exactly 1 notification after repeat invite (dedup verified)');
    assert(notifsDedupRes.data.notifications[0].notification_id === firstNotifId, 'Same notification row was updated');

    // Acknowledge notification (POST /notifications/ack)
    const ackRes = await fetch(`${baseUrl}/api/v1/notifications/ack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userB,
        'x-auth-token': tokenB,
      },
      body: JSON.stringify({ all: true }),
    });
    const ackData = await ackRes.json();
    assert(ackData.data.removed === 1, 'Acknowledged and removed 1 notification');

    const notifsAfterAck = await fetch(`${baseUrl}/api/v1/notifications`, {
      headers: { 'x-user-id': userB, 'x-auth-token': tokenB },
    }).then((r) => r.json());
    assert(notifsAfterAck.data.notifications.length === 0, 'Notifications list is now empty');

    // ----------------------------------------------------
    // CLEANUP & SUMMARY
    // ----------------------------------------------------
    socketA.close();
    socketC.close();

    console.log('\n====================================================');
    console.log(`🎉 ALL FRIENDS V2 TESTS PASSED! (${passed}/${passed})`);
    console.log('====================================================\n');
  } catch (err) {
    console.error('\n❌ TEST SUITE FAILED:', err);
    process.exit(1);
  } finally {
    server.close();
    await closePool();
  }
}

runTests();
