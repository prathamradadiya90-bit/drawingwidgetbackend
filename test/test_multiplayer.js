import http from 'node:http';
import { io as Client } from 'socket.io-client';
import app from '../src/app.js';
import { initializeSocket } from '../src/sockets/index.js';
import { pool, closePool } from '../src/config/db.js';

const TEST_PORT = 3456;
const server = http.createServer(app);
initializeSocket(server);

async function runTests() {
  console.log('--- Starting Multiplayer & Live Drawing Backend Tests ---');

  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`Test server running on port ${TEST_PORT}`);

  const baseUrl = `http://localhost:${TEST_PORT}`;
  let createdRoomId = null;

  try {
    // 1. Health check
    console.log('\n[1] Testing GET /health ...');
    const healthRes = await fetch(`${baseUrl}/health`);
    const healthData = await healthRes.json();
    if (healthData.status !== 'ok' || healthData.database !== 'connected') {
      throw new Error('Health check failed or database not connected');
    }
    console.log('✓ Health check passed');

    // 2. Room creation
    console.log('\n[2] Testing POST /api/v1/rooms (Create Room) ...');
    const hostUserId = 'test-user-host-001';
    const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': hostUserId,
        'devicetype': 'ios',
      },
      body: JSON.stringify({
        svg_resource: '<svg>test-canvas</svg>',
        player_count: 2,
        name: 'Host Player',
      }),
    });
    const createData = await createRes.json();
    if (!createData.success || !createData.data?.room?.code) {
      throw new Error('Room creation failed');
    }

    createdRoomId = createData.data.room.id;
    const createdRoomCode = createData.data.room.code;
    const hostSlot = createData.data.slot_index;
    console.log(`✓ Room created (Code: ${createdRoomCode}, Host Slot: ${hostSlot})`);

    // 3. Room join
    console.log('\n[3] Testing POST /api/v1/rooms/join (Guest Player Join) ...');
    const guestUserId = 'test-user-guest-002';
    const joinRes = await fetch(`${baseUrl}/api/v1/rooms/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': guestUserId,
        'devicetype': 'ios',
      },
      body: JSON.stringify({
        code: createdRoomCode,
        name: 'Guest Player',
      }),
    });
    const joinData = await joinRes.json();
    if (!joinData.success || !joinData.data?.slot_index) {
      throw new Error('Room join failed');
    }
    const guestSlot = joinData.data.slot_index;
    if (hostSlot === guestSlot) {
      throw new Error('Slot collision detected');
    }
    console.log(`✓ Guest joined room (Guest Slot: ${guestSlot})`);

    // 4. Room details
    console.log('\n[4] Testing GET /api/v1/rooms/:id ...');
    const roomInfoRes = await fetch(`${baseUrl}/api/v1/rooms/${createdRoomId}`);
    const roomInfoData = await roomInfoRes.json();
    if (!roomInfoData.success || roomInfoData.data.members.length !== 2) {
      throw new Error('Expected 2 active members in room');
    }
    console.log('✓ Room details verified with 2 active members');

    // 5. WebSockets Live Drawing
    console.log('\n[5] Testing WebSocket Live Drawing & Synchronization (/v1) ...');
    const hostSocket = Client(`${baseUrl}/v1`, {
      auth: { userId: hostUserId, devicetype: 'ios' },
      transports: ['websocket'],
    });

    const guestSocket = Client(`${baseUrl}/v1`, {
      auth: { userId: guestUserId, devicetype: 'ios' },
      transports: ['websocket'],
    });

    await Promise.all([
      new Promise((resolve) => hostSocket.on('connect', resolve)),
      new Promise((resolve) => guestSocket.on('connect', resolve)),
    ]);

    await new Promise((resolve) => hostSocket.emit('room:join', { room_id: createdRoomId }, resolve));
    await new Promise((resolve) => guestSocket.emit('room:join', { room_id: createdRoomId }, resolve));
    console.log('✓ Both sockets connected and joined room');

    // 6. Real-time stroke movement relay
    console.log('\n[6] Testing stroke:move (Live Drawing Relay) ...');
    const moveReceivedPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for stroke:move')), 5000);
      guestSocket.on('stroke:move', (data) => {
        clearTimeout(timeout);
        resolve(data);
      });
    });

    hostSocket.emit('stroke:move', {
      id: '11111111-1111-4111-8111-111111111111',
      step_index: 1,
      kind: 'line',
      stroke_data: 'base64-live-coordinates',
    });

    await moveReceivedPromise;
    console.log('✓ Live stroke:move successfully relayed to guest in real time');

    // 7. Final stroke persistence & broadcast
    console.log('\n[7] Testing stroke:add (Broadcast & Persistence) ...');
    const addReceivedPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for stroke:add')), 5000);
      guestSocket.on('stroke:add', (data) => {
        clearTimeout(timeout);
        resolve(data);
      });
    });

    hostSocket.emit('stroke:add', {
      id: '22222222-2222-4222-8222-222222222222',
      step_index: 1,
      kind: 'line',
      stroke_data: 'base64-final-drawing-data',
    });

    await addReceivedPromise;
    console.log('✓ stroke:add successfully broadcasted to guest');

    // Wait for DB write
    await new Promise((r) => setTimeout(r, 600));

    // 8. Backfill verification
    console.log('\n[8] Testing GET /api/v1/rooms/:id/strokes (Canvas Backfill Check) ...');
    const strokesRes = await fetch(`${baseUrl}/api/v1/rooms/${createdRoomId}/strokes`, {
      headers: { 'x-user-id': guestUserId },
    });
    const strokesData = await strokesRes.json();
    if (!strokesData.success || strokesData.data.strokes.length !== 1) {
      throw new Error(`Expected 1 persisted stroke, got ${strokesData.data?.strokes?.length}`);
    }
    console.log('✓ Stroke correctly verified in database');

    hostSocket.disconnect();
    guestSocket.disconnect();

    // 9. Leave room
    console.log('\n[9] Testing POST /api/v1/rooms/leave ...');
    const leaveRes = await fetch(`${baseUrl}/api/v1/rooms/leave`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': guestUserId,
      },
      body: JSON.stringify({ room_id: createdRoomId }),
    });
    const leaveData = await leaveRes.json();
    if (!leaveData.success || leaveData.data.remaining_members !== 1) {
      throw new Error('Leave room failed');
    }
    console.log('✓ Leave room verified');

    console.log('\n=== ALL TESTS PASSED SUCCESSFULLY! ===\n');
  } finally {
    if (createdRoomId) {
      await pool.query('DELETE FROM rooms WHERE id = $1', [createdRoomId]).catch(() => {});
    }
    server.close();
    await closePool();
  }
}

runTests().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
