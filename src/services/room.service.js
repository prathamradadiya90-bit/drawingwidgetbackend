import { pool, withTransaction } from '../config/db.js';
import { RoomLimits, DeviceTypes } from '../helpers/constants.js';

/**
 * Generate random unambiguous room code
 */
export function generateRoomCode(length = RoomLimits.CODE_LENGTH) {
  const chars = RoomLimits.CODE_ALPHABET;
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * Get fallback name for user
 */
export function getDefaultUserName(userId) {
  if (!userId) return `User-${Math.floor(1000 + Math.random() * 9000)}`;
  return `User-${userId.substring(0, 5)}`;
}

/**
 * Custom AppError helper
 */
export class ServiceError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'ServiceError';
  }
}

export const roomService = {
  /**
   * Create a new multiplayer drawing room
   */
  async createRoom({ svgResource = null, playerCount = 2, name, profileImage = null, hostId, deviceType = DeviceTypes.IOS }) {
    if (svgResource !== undefined && svgResource !== null && typeof svgResource !== 'string') {
      throw new ServiceError('svg_resource must be a string if provided', 422);
    }

    const count = parseInt(playerCount, 10);
    if (isNaN(count) || count < RoomLimits.MIN_PLAYERS || count > RoomLimits.MAX_PLAYERS) {
      throw new ServiceError(`player_count must be between ${RoomLimits.MIN_PLAYERS} and ${RoomLimits.MAX_PLAYERS}`, 422);
    }

    return await withTransaction(async (client) => {
      let code = '';
      for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = generateRoomCode();
        const { rowCount } = await client.query('SELECT 1 FROM rooms WHERE code = $1', [candidate]);
        if (rowCount === 0) {
          code = candidate;
          break;
        }
      }

      if (!code) {
        throw new ServiceError('Could not allocate a unique room code. Please try again.', 500);
      }

      const { rows } = await client.query(
        `INSERT INTO rooms (code, svg_resource, host_id, player_count, device_type)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [code, svgResource || null, hostId, count, deviceType]
      );
      const room = rows[0];

      // Assign host a random slot index (1..player_count)
      const slotIndex = 1 + Math.floor(Math.random() * count);
      const memberName = name || getDefaultUserName(hostId);

      await client.query(
        `INSERT INTO room_members (room_id, user_id, slot_index, name, profile_image)
         VALUES ($1, $2, $3, $4, $5)`,
        [room.id, hostId, slotIndex, memberName, profileImage || null]
      );

      return {
        room,
        slot_index: slotIndex,
      };
    });
  },

  /**
   * Join an existing multiplayer room using room code
   */
  async joinRoom({ code, name, profileImage = null, userId, deviceType = DeviceTypes.IOS }) {
    if (!code || typeof code !== 'string') {
      throw new ServiceError('Room code is required', 422);
    }

    const normalizedCode = code.trim().toUpperCase();
    const MAX_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await withTransaction(async (client) => {
          // Lock room row for atomic slot reservation
          const roomRes = await client.query('SELECT * FROM rooms WHERE code = $1 FOR UPDATE', [normalizedCode]);
          const room = roomRes.rows[0];

          if (!room) {
            throw new ServiceError(`No room found with code ${normalizedCode}`, 404);
          }

          if (room.device_type !== deviceType) {
            throw new ServiceError(`Cannot join a room created on a different platform (${room.device_type})`, 400);
          }

          // Check if user is already an active member (rejoining)
          const existingRes = await client.query(
            'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2',
            [room.id, userId]
          );

          if (existingRes.rows[0]) {
            const existingMember = existingRes.rows[0];
            if (existingMember.left_at === null && existingMember.slot_index !== null) {
              // Update name or profileImage if provided on rejoining
              if (name || profileImage) {
                await client.query(
                  `UPDATE room_members
                   SET name = COALESCE($3, name), profile_image = COALESCE($4, profile_image)
                   WHERE room_id = $1 AND user_id = $2`,
                  [room.id, userId, name || null, profileImage || null]
                );
              }
              return {
                room,
                slot_index: existingMember.slot_index,
              };
            }
          }

          // Calculate available slots (only active members holding slots)
          const takenRes = await client.query(
            'SELECT slot_index FROM room_members WHERE room_id = $1 AND left_at IS NULL AND slot_index IS NOT NULL',
            [room.id]
          );
          const takenSlots = new Set(takenRes.rows.map((r) => r.slot_index));

          const availableSlots = [];
          for (let slot = 1; slot <= room.player_count; slot++) {
            if (!takenSlots.has(slot)) {
              availableSlots.push(slot);
            }
          }

          if (availableSlots.length === 0) {
            throw new ServiceError('Room is full', 409);
          }

          // Assign a random available slot
          const slotIndex = availableSlots[Math.floor(Math.random() * availableSlots.length)];
          const memberName = name || getDefaultUserName(userId);

          if (existingRes.rows[0]) {
            await client.query(
              `UPDATE room_members
               SET left_at = NULL, slot_index = $3, name = COALESCE($4, name, $5), profile_image = COALESCE($6, profile_image)
               WHERE room_id = $1 AND user_id = $2`,
              [room.id, userId, slotIndex, name || null, getDefaultUserName(userId), profileImage || null]
            );
          } else {
            await client.query(
              `INSERT INTO room_members (room_id, user_id, slot_index, name, profile_image)
               VALUES ($1, $2, $3, $4, $5)`,
              [room.id, userId, slotIndex, memberName, profileImage || null]
            );
          }

          return {
            room,
            slot_index: slotIndex,
          };
        });
      } catch (err) {
        // Unique constraint violation on (room_id, slot_index) means slot was taken concurrently
        const isUniqueViolation = typeof err === 'object' && err !== null && err.code === '23505';
        if (isUniqueViolation && attempt < MAX_ATTEMPTS - 1) {
          continue;
        }
        throw err;
      }
    }
  },

  /**
   * Leave a multiplayer room
   * If host leaves, the room session is closed for all members.
   * If non-host leaves, their slot is freed up for other players.
   */
  async leaveRoom({ roomId, userId }) {
    if (!roomId) throw new ServiceError('room_id is required', 422);

    return await withTransaction(async (client) => {
      const roomRes = await client.query('SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
      const room = roomRes.rows[0];
      if (!room) {
        throw new ServiceError('Room not found', 404);
      }

      const isHost = room.host_id === userId;

      if (isHost) {
        // Host departure closes room and releases all slots
        await client.query(
          `UPDATE room_members
           SET left_at = NOW(), slot_index = NULL
           WHERE room_id = $1 AND left_at IS NULL`,
          [roomId]
        );

        return {
          left: true,
          is_host: true,
          room_closed: true,
          remaining_members: 0,
        };
      }

      // Non-host departure frees their slot
      await client.query(
        `UPDATE room_members
         SET left_at = NOW(), slot_index = NULL
         WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [roomId, userId]
      );

      const countRes = await client.query(
        'SELECT count(*)::int AS count FROM room_members WHERE room_id = $1 AND left_at IS NULL',
        [roomId]
      );
      const remainingCount = countRes.rows[0]?.count || 0;

      return {
        left: true,
        is_host: false,
        room_closed: false,
        remaining_members: remainingCount,
      };
    });
  },

  /**
   * Get room metadata and active member list
   */
  async getRoom(roomId) {
    const roomRes = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    const room = roomRes.rows[0];
    if (!room) {
      throw new ServiceError('Room not found', 404);
    }

    const membersRes = await pool.query(
      `SELECT user_id, slot_index, name, profile_image, joined_at
       FROM room_members
       WHERE room_id = $1 AND left_at IS NULL
       ORDER BY slot_index ASC`,
      [roomId]
    );

    return {
      room,
      members: membersRes.rows,
    };
  },

  /**
   * Verify if a user is a member of the room
   */
  async isRoomMember(roomId, userId) {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL',
      [roomId, userId]
    );
    return (rowCount || 0) > 0;
  },

  /**
   * Get active member record (returns null if user never joined via REST or has already left)
   */
  async getRoomMemberRaw(roomId, userId) {
    const res = await pool.query(
      'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL',
      [roomId, userId]
    );
    return res.rows[0] || null;
  },

  /**
   * Reap idle rooms
   */
  async reapStaleRooms(maxIdleHours = 24) {
    const { rowCount } = await pool.query(
      `DELETE FROM rooms r
       WHERE COALESCE(
         (SELECT MAX(created_at) FROM room_strokes s WHERE s.room_id = r.id),
         r.created_at
       ) < NOW() - ($1 * INTERVAL '1 hour')`,
      [maxIdleHours]
    );
    return rowCount || 0;
  },
};
