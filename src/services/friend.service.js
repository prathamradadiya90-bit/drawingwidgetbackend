import crypto from 'node:crypto';
import { pool } from '../config/db.js';
import { FriendLimits, ErrorCodes, SocketEvents, normalizeGameType } from '../helpers/constants.js';
import { logger } from '../helpers/logger.js';
import {
  generateDeviceToken,
  hashDeviceToken,
  verifyDeviceToken,
} from '../helpers/auth.helper.js';
import { notificationService } from './notification.service.js';

export class FriendServiceError extends Error {
  constructor(message, statusCode = 400, code = null) {
    super(message);
    this.name = 'FriendServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

// Normalize friend code: strip spaces/dashes, uppercase
export function normalizeFriendCode(code) {
  if (!code || typeof code !== 'string') return '';
  return code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

// Validate friend code format: exactly 8 characters from Crockford/safe base32
export function isValidFriendCode(code) {
  const normalized = normalizeFriendCode(code);
  if (normalized.length !== FriendLimits.CODE_LENGTH) return false;
  const regex = new RegExp(`^[${FriendLimits.CODE_ALPHABET}]{${FriendLimits.CODE_LENGTH}}$`);
  return regex.test(normalized);
}

// Format friend code with dash: ABCD2345 -> ABCD-2345
export function formatFriendCodeWithDash(code) {
  const norm = normalizeFriendCode(code);
  if (norm.length === 8) {
    return `${norm.slice(0, 4)}-${norm.slice(4)}`;
  }
  return norm || code;
}

// Generate random 8-character friend code from alphabet
export function generateRandomFriendCode() {
  const chars = FriendLimits.CODE_ALPHABET;
  let code = '';
  for (let i = 0; i < FriendLimits.CODE_LENGTH; i++) {
    const randomIndex = Math.floor(Math.random() * chars.length);
    code += chars[randomIndex];
  }
  return code;
}

// In-memory rate limiter for by-code lookups: 20 per minute per user
const lookupRateLimiter = new Map(); // userId -> [timestamps]

function checkLookupRateLimit(userId) {
  if (!userId) return;
  const now = Date.now();
  const windowStart = now - FriendLimits.LOOKUP_RATE_LIMIT_WINDOW_MS;
  let timestamps = lookupRateLimiter.get(userId) || [];
  timestamps = timestamps.filter((t) => t > windowStart);
  if (timestamps.length >= FriendLimits.LOOKUP_RATE_LIMIT_MAX) {
    throw new FriendServiceError(
      'Too many tries. Wait a minute and try again.',
      429,
      ErrorCodes.TOO_MANY_LOOKUPS
    );
  }
  timestamps.push(now);
  lookupRateLimiter.set(userId, timestamps);
}

// In-memory user presence: userId -> { status, game, sockets: Set, disconnectTimer }
const presenceMap = new Map();

export function getUserPresence(userId) {
  const entry = presenceMap.get(userId);
  if (!entry || entry.sockets.size === 0) {
    return {
      is_online: false,
      status: 'offline',
      game: null,
    };
  }
  return {
    is_online: true,
    status: entry.status || 'online',
    game: entry.game || null,
  };
}

export function getAllFriendsPresence(friendUserIds) {
  return friendUserIds.map((fId) => {
    const pres = getUserPresence(fId);
    return {
      user_id: fId,
      status: pres.status,
      game: pres.game,
    };
  });
}

// Helper to broadcast presence change to all mutual friends of a user
export async function broadcastPresenceToFriends(io, userId, status, game = null) {
  if (!io) return;
  try {
    const { rows } = await pool.query(
      `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS friend_id
       FROM friendships
       WHERE user_a = $1 OR user_b = $1`,
      [userId]
    );

    const payload = { user_id: userId, status, game };
    for (const row of rows) {
      const friendRoom = `user:${row.friend_id}`;
      io.of('/v1').to(friendRoom).emit(SocketEvents.FRIEND_PRESENCE, payload);
      io.to(friendRoom).emit(SocketEvents.FRIEND_PRESENCE, payload);
    }
  } catch (err) {
    if (err?.message?.includes('pool after calling end') || pool.ending) {
      return; // Gracefully handle shutdown during test or exit
    }
    logger.error(`Failed to broadcast presence to friends of ${userId}:`, err);
  }
}

// Handle socket connect for presence
export async function handleSocketConnect(io, socket, userId) {
  const personalRoom = `user:${userId}`;
  socket.join(personalRoom);

  let entry = presenceMap.get(userId);
  if (entry) {
    if (entry.disconnectTimer) {
      clearTimeout(entry.disconnectTimer);
      entry.disconnectTimer = null;
    }
    entry.sockets.add(socket.id);
  } else {
    entry = {
      status: 'online',
      game: null,
      sockets: new Set([socket.id]),
      disconnectTimer: null,
    };
    presenceMap.set(userId, entry);
    // User newly came online: broadcast to friends
    await broadcastPresenceToFriends(io, userId, 'online', null);
  }

  // Send connecting user the list of all their friends' current presence
  try {
    const { rows } = await pool.query(
      `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS friend_id
       FROM friendships
       WHERE user_a = $1 OR user_b = $1`,
      [userId]
    );
    const friendIds = rows.map((r) => r.friend_id);
    const friendsPresence = getAllFriendsPresence(friendIds);
    socket.emit(SocketEvents.FRIENDS_PRESENCE, { friends: friendsPresence });
  } catch (err) {
    logger.error(`Error sending friends:presence to ${userId}:`, err);
  }
}

// Handle socket disconnect for presence
export function handleSocketDisconnect(io, socket, userId) {
  const entry = presenceMap.get(userId);
  if (!entry) return;

  entry.sockets.delete(socket.id);

  if (entry.sockets.size === 0) {
    if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
    entry.disconnectTimer = setTimeout(async () => {
      // Grace period expired without re-connect -> user is offline
      presenceMap.delete(userId);
      await broadcastPresenceToFriends(io, userId, 'offline', null);
    }, FriendLimits.DISCONNECT_GRACE_MS);
  }
}

// Update user in_game presence
export async function setPlayerInGame(io, userId, gameName) {
  const entry = presenceMap.get(userId);
  if (entry) {
    entry.status = 'in_game';
    entry.game = gameName;
  } else {
    presenceMap.set(userId, {
      status: 'in_game',
      game: gameName,
      sockets: new Set(),
      disconnectTimer: null,
    });
  }
  await broadcastPresenceToFriends(io, userId, 'in_game', gameName);
}

// Clear user in_game presence back to online
export async function clearPlayerInGame(io, userId) {
  const entry = presenceMap.get(userId);
  if (entry && entry.sockets.size > 0) {
    entry.status = 'online';
    entry.game = null;
    await broadcastPresenceToFriends(io, userId, 'online', null);
  } else {
    presenceMap.delete(userId);
    await broadcastPresenceToFriends(io, userId, 'offline', null);
  }
}

// ----------------------------------------------------
// In-Memory Game Invites
// ----------------------------------------------------
// inviteId -> { invite_id, host_user_id, to_user_id, game, room_code, expires_at, timer }
const activeInvites = new Map();

export async function createGameInvite(io, { hostUserId, toUserId, game, roomCode }) {
  const normalizedHostId = String(hostUserId || '').trim().toLowerCase();
  const normalizedToId = String(toUserId || '').trim().toLowerCase();

  // 1. Verify mutual friendship
  const userA = normalizedHostId < normalizedToId ? normalizedHostId : normalizedToId;
  const userB = normalizedHostId < normalizedToId ? normalizedToId : normalizedHostId;
  const { rows: friendRows } = await pool.query(
    'SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2',
    [userA, userB]
  );
  if (friendRows.length === 0) {
    throw new FriendServiceError(
      'You can only invite friends',
      400,
      ErrorCodes.NOT_FRIENDS
    );
  }

  // 2. Verify game exists and caller is host and game is waiting
  const normalizedGame = normalizeGameType(game);
  const rawRoomCode = String(roomCode || '').replace(/["'“”]/g, '').trim();
  const normalizedRoomCode = rawRoomCode.toUpperCase();
  let gameRow = null;
  let isWaiting = false;

  if (normalizedGame === 'shoot') {
    const { rows } = await pool.query(
      'SELECT id, code, host_id, status FROM shoot_games WHERE code = $1',
      [normalizedRoomCode]
    );
    gameRow = rows[0];
    if (gameRow) isWaiting = gameRow.status === 'waiting';
  } else if (normalizedGame === 'knife') {
    const { rows } = await pool.query(
      'SELECT id, code, host_id, status FROM knife_games WHERE code = $1',
      [normalizedRoomCode]
    );
    gameRow = rows[0];
    if (gameRow) isWaiting = gameRow.status === 'waiting';
  } else if (normalizedGame === 'tictactoe') {
    const { rows } = await pool.query(
      'SELECT id, code, host_id, status FROM ttt_games WHERE code = $1',
      [normalizedRoomCode]
    );
    gameRow = rows[0];
    if (gameRow) isWaiting = gameRow.status === 'waiting';
  } else if (normalizedGame === 'drawing') {
    const { rows } = await pool.query(
      `SELECT r.id, r.code, r.host_id, r.player_count,
              (SELECT count(*)::int FROM room_members rm WHERE rm.room_id = r.id AND rm.left_at IS NULL) AS member_count
       FROM rooms r
       WHERE UPPER(TRIM(r.code)) = $1 OR r.id::text = $2`,
      [normalizedRoomCode, rawRoomCode.toLowerCase()]
    );
    gameRow = rows[0];
    if (gameRow) {
      isWaiting = parseInt(gameRow.member_count, 10) < parseInt(gameRow.player_count, 10);
    }
  } else {
    throw new FriendServiceError(
      'That game has ended. Start a new one.',
      400,
      ErrorCodes.GAME_NOT_FOUND
    );
  }

  if (!gameRow) {
    const notFoundMsg = normalizedGame === 'drawing'
      ? 'That room has closed. Start a new one.'
      : 'That game has ended. Start a new one.';
    throw new FriendServiceError(
      notFoundMsg,
      404,
      ErrorCodes.GAME_NOT_FOUND
    );
  }

  if ((gameRow.host_id || '').trim().toLowerCase() !== normalizedHostId) {
    throw new FriendServiceError(
      'Only the host can invite',
      403,
      ErrorCodes.NOT_HOST
    );
  }

  if (!isWaiting) {
    const fullMsg = normalizedGame === 'drawing'
      ? 'Your room already has two people'
      : 'Your game already has two players';
    throw new FriendServiceError(
      fullMsg,
      409,
      ErrorCodes.GAME_FULL
    );
  }

  // 3. Verify friend presence and name
  const { rows: friendUsers } = await pool.query(
    'SELECT name FROM users WHERE user_id = $1',
    [normalizedToId]
  );
  const friendName = friendUsers[0]?.name || 'Friend';

  const friendPresence = getUserPresence(normalizedToId);
  if (!friendPresence.is_online) {
    // Record missed invite with reason: "OFFLINE"
    notificationService.recordMissedInvite(io, {
      toUserId: normalizedToId,
      fromUserId: normalizedHostId,
      game: normalizedGame,
      reason: 'OFFLINE',
    }).catch((err) => {
      logger.error('Failed to record offline missed invite:', err);
    });

    throw new FriendServiceError(
      `${friendName} is offline. We'll let them know you invited them.`,
      400,
      ErrorCodes.FRIEND_OFFLINE
    );
  }

  if (friendPresence.status === 'in_game') {
    throw new FriendServiceError(
      `${friendName} is in another game`,
      400,
      ErrorCodes.FRIEND_BUSY
    );
  }

  // 4. Cancel any previous invite sent by this host (replaces old invite)
  for (const [id, inv] of activeInvites.entries()) {
    if (inv.host_user_id === normalizedHostId) {
      clearTimeout(inv.timer);
      activeInvites.delete(id);
      const cancelPayload = { invite_id: id, reason: ErrorCodes.REPLACED };
      if (io) {
        io.of('/v1').to(`user:${inv.host_user_id}`).emit(SocketEvents.INVITE_CANCELLED, cancelPayload);
        io.of('/v1').to(`user:${inv.to_user_id}`).emit(SocketEvents.INVITE_CANCELLED, cancelPayload);
        io.to(`user:${inv.host_user_id}`).emit(SocketEvents.INVITE_CANCELLED, cancelPayload);
        io.to(`user:${inv.to_user_id}`).emit(SocketEvents.INVITE_CANCELLED, cancelPayload);
      }
    }
  }

  // 5. Fetch host user info to show in invite banner
  const { rows: hostUsers } = await pool.query(
    'SELECT user_id, name, profile_image, friend_code FROM users WHERE user_id = $1',
    [normalizedHostId]
  );
  const hostUser = hostUsers[0] || {
    user_id: normalizedHostId,
    name: 'Friend',
    profile_image: 'A1',
    friend_code: '',
  };

  const inviteId = crypto.randomUUID();
  const expiresAt = Date.now() + FriendLimits.INVITE_TIMEOUT_MS;

  const timer = setTimeout(() => {
    activeInvites.delete(inviteId);
    const expirePayload = { invite_id: inviteId };
    if (io) {
      io.of('/v1').to(`user:${normalizedHostId}`).emit(SocketEvents.INVITE_EXPIRED, expirePayload);
      io.of('/v1').to(`user:${normalizedToId}`).emit(SocketEvents.INVITE_EXPIRED, expirePayload);
      io.to(`user:${normalizedHostId}`).emit(SocketEvents.INVITE_EXPIRED, expirePayload);
      io.to(`user:${normalizedToId}`).emit(SocketEvents.INVITE_EXPIRED, expirePayload);
    }

    // Record missed invite with reason: "NO_ANSWER"
    notificationService.recordMissedInvite(io, {
      toUserId: normalizedToId,
      fromUserId: normalizedHostId,
      game: normalizedGame,
      reason: 'NO_ANSWER',
    }).catch((err) => {
      logger.error('Failed to record expired missed invite:', err);
    });
  }, FriendLimits.INVITE_TIMEOUT_MS);

  const cleanRoomCode = gameRow.code || normalizedRoomCode;
  const inviteObj = {
    invite_id: inviteId,
    host_user_id: normalizedHostId,
    to_user_id: normalizedToId,
    game: normalizedGame,
    room_code: cleanRoomCode,
    room_id: gameRow.id,
    expires_at: expiresAt,
    timer,
  };
  activeInvites.set(inviteId, inviteObj);

  // 6. Deliver invite:received event to friend's personal socket room
  const inviteReceivedPayload = {
    invite_id: inviteId,
    game: normalizedGame,
    room_code: cleanRoomCode,
    from: {
      user_id: hostUser.user_id,
      name: hostUser.name,
      profile_image: hostUser.profile_image,
      friend_code: hostUser.friend_code,
    },
    expires_at: expiresAt,
  };

  io.of('/v1').to(`user:${normalizedToId}`).emit(SocketEvents.INVITE_RECEIVED, inviteReceivedPayload);
  io.to(`user:${normalizedToId}`).emit(SocketEvents.INVITE_RECEIVED, inviteReceivedPayload);

  return {
    invite_id: inviteId,
    expires_at: expiresAt,
  };
}

export async function respondToGameInvite(io, { inviteId, friendUserId, accept }) {
  const invite = activeInvites.get(inviteId);
  if (!invite || invite.to_user_id !== friendUserId) {
    throw new FriendServiceError(
      'Invite has expired or already ended',
      400,
      ErrorCodes.INVITE_ENDED
    );
  }

  clearTimeout(invite.timer);
  activeInvites.delete(inviteId);

  const hostUserId = invite.host_user_id;

  if (!accept) {
    // Declined
    const payload = { invite_id: inviteId, by_user_id: friendUserId };
    io.of('/v1').to(`user:${hostUserId}`).emit(SocketEvents.INVITE_DECLINED, payload);
    io.to(`user:${hostUserId}`).emit(SocketEvents.INVITE_DECLINED, payload);
    return { ok: true, accepted: false };
  }

  // Accepted: check if game/room is still waiting
  const normalizedGame = normalizeGameType(invite.game);
  let gameRow = null;
  let stillOpen = false;

  if (normalizedGame === 'shoot') {
    const { rows } = await pool.query(
      'SELECT id, code, status FROM shoot_games WHERE code = $1',
      [invite.room_code]
    );
    gameRow = rows[0];
    stillOpen = Boolean(gameRow && gameRow.status === 'waiting');
  } else if (normalizedGame === 'knife') {
    const { rows } = await pool.query(
      'SELECT id, code, status FROM knife_games WHERE code = $1',
      [invite.room_code]
    );
    gameRow = rows[0];
    stillOpen = Boolean(gameRow && gameRow.status === 'waiting');
  } else if (normalizedGame === 'tictactoe') {
    const { rows } = await pool.query(
      'SELECT id, code, status FROM ttt_games WHERE code = $1',
      [invite.room_code]
    );
    gameRow = rows[0];
    stillOpen = Boolean(gameRow && gameRow.status === 'waiting');
  } else if (normalizedGame === 'drawing') {
    const { rows } = await pool.query(
      `SELECT r.id, r.code, r.player_count,
              (SELECT count(*)::int FROM room_members rm WHERE rm.room_id = r.id AND rm.left_at IS NULL) AS member_count
       FROM rooms r
       WHERE UPPER(TRIM(r.code)) = $1 OR r.id::text = $2`,
      [invite.room_code.toUpperCase(), (invite.room_id || invite.room_code).toLowerCase()]
    );
    gameRow = rows[0];
    stillOpen = Boolean(gameRow && parseInt(gameRow.member_count, 10) < parseInt(gameRow.player_count, 10));
  }

  if (!stillOpen) {
    throw new FriendServiceError(
      'Invite has expired or already ended',
      400,
      ErrorCodes.INVITE_ENDED
    );
  }

  const payload = {
    invite_id: inviteId,
    by_user_id: String(friendUserId).trim().toLowerCase(),
    game: normalizedGame,
    room_code: gameRow?.code || invite.room_code,
  };

  io.of('/v1').to(`user:${hostUserId}`).emit(SocketEvents.INVITE_ACCEPTED, payload);
  io.to(`user:${hostUserId}`).emit(SocketEvents.INVITE_ACCEPTED, payload);

  return {
    ok: true,
    accepted: true,
    game: normalizedGame,
    room_code: gameRow?.code || invite.room_code,
  };
}

export function cancelGameInvite(io, { inviteId, hostUserId }) {
  const invite = activeInvites.get(inviteId);
  if (!invite) return { ok: true };

  const normalizedHostId = String(hostUserId || '').trim().toLowerCase();
  if (invite.host_user_id !== normalizedHostId) {
    throw new FriendServiceError(
      'Only the host can cancel this invite',
      403,
      ErrorCodes.NOT_HOST
    );
  }

  clearTimeout(invite.timer);
  activeInvites.delete(inviteId);

  const cancelPayload = { invite_id: inviteId, reason: ErrorCodes.CANCELLED };
  io.of('/v1').to(`user:${invite.host_user_id}`).emit(SocketEvents.INVITE_CANCELLED, cancelPayload);
  io.of('/v1').to(`user:${invite.to_user_id}`).emit(SocketEvents.INVITE_CANCELLED, cancelPayload);
  io.to(`user:${invite.host_user_id}`).emit(SocketEvents.INVITE_CANCELLED, cancelPayload);
  io.to(`user:${invite.to_user_id}`).emit(SocketEvents.INVITE_CANCELLED, cancelPayload);

  return { ok: true };
}

export function cancelInvitesForGameRoom(io, { game, roomCode, reason = ErrorCodes.GAME_FULL }) {
  if (!roomCode) return;
  const upperCode = String(roomCode).trim().toUpperCase();
  const lowerCode = String(roomCode).trim().toLowerCase();
  for (const [id, inv] of activeInvites.entries()) {
    if (inv.room_code.toUpperCase() === upperCode || (inv.room_id && inv.room_id.toLowerCase() === lowerCode)) {
      clearTimeout(inv.timer);
      activeInvites.delete(id);
      const cancelPayload = { invite_id: id, reason };
      if (io) {
        io.of('/v1').to(`user:${inv.host_user_id}`).emit(SocketEvents.INVITE_CANCELLED, cancelPayload);
        io.of('/v1').to(`user:${inv.to_user_id}`).emit(SocketEvents.INVITE_CANCELLED, cancelPayload);
        io.to(`user:${inv.host_user_id}`).emit(SocketEvents.INVITE_CANCELLED, cancelPayload);
        io.to(`user:${inv.to_user_id}`).emit(SocketEvents.INVITE_CANCELLED, cancelPayload);
      }
    }
  }
}

// ----------------------------------------------------
// Database Operations Service
// ----------------------------------------------------
export const friendService = {
  // POST /users/register
  async registerUser({ userId, deviceId, name, profileImage, platform, authToken }) {
    const normalizedUserId = (userId || '').trim().toLowerCase();
    const cleanName = (name || '').trim().slice(0, 20) || 'Player';
    const cleanAvatar = (profileImage || '').trim() || 'A1';
    const cleanPlatform = (platform || '').trim().toLowerCase() || 'ios';
    const cleanDeviceId = (deviceId || '').trim() || null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if user already exists
      const { rows: existingRows } = await client.query(
        'SELECT * FROM users WHERE user_id = $1 FOR UPDATE',
        [normalizedUserId]
      );

      let user = null;
      let newlyGeneratedToken = null;

      if (existingRows.length > 0) {
        const existing = existingRows[0];
        if (existing.auth_token_hash) {
          // User already has a token. Verify if authToken was passed directly:
          if (authToken && !verifyDeviceToken(authToken, existing.auth_token_hash)) {
            throw new FriendServiceError(
              'Your session is no longer valid. Reinstall the app or contact support.',
              401
            );
          }
          // Update user without generating a new token
          const { rows: updatedRows } = await client.query(
            `UPDATE users
             SET name = COALESCE($2, name),
                 profile_image = COALESCE($3, profile_image),
                 device_id = COALESCE($4, device_id),
                 platform = COALESCE($5, platform),
                 last_seen_at = NOW()
             WHERE user_id = $1
             RETURNING *`,
            [normalizedUserId, cleanName, cleanAvatar, cleanDeviceId, cleanPlatform]
          );
          user = updatedRows[0];
        } else {
          // Existing user without a token claiming their token for the first time
          newlyGeneratedToken = generateDeviceToken();
          const tokenHash = hashDeviceToken(newlyGeneratedToken);

          const { rows: updatedRows } = await client.query(
            `UPDATE users
             SET name = COALESCE($2, name),
                 profile_image = COALESCE($3, profile_image),
                 device_id = COALESCE($4, device_id),
                 platform = COALESCE($5, platform),
                 auth_token_hash = $6,
                 last_seen_at = NOW()
             WHERE user_id = $1
             RETURNING *`,
            [normalizedUserId, cleanName, cleanAvatar, cleanDeviceId, cleanPlatform, tokenHash]
          );
          user = updatedRows[0];
        }
      } else {
        // Create user with new unique friend code and new device token
        newlyGeneratedToken = generateDeviceToken();
        const tokenHash = hashDeviceToken(newlyGeneratedToken);

        let inserted = false;
        let attempts = 0;
        while (!inserted && attempts < 10) {
          attempts++;
          const code = generateRandomFriendCode();
          try {
            const { rows: newRows } = await client.query(
              `INSERT INTO users (user_id, friend_code, name, profile_image, device_id, platform, auth_token_hash, last_seen_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
               RETURNING *`,
              [normalizedUserId, code, cleanName, cleanAvatar, cleanDeviceId, cleanPlatform, tokenHash]
            );
            user = newRows[0];
            inserted = true;
          } catch (insertErr) {
            // Retry on unique constraint violation for friend_code
            if (insertErr.code === '23505' && insertErr.constraint === 'users_friend_code_key') {
              continue;
            }
            throw insertErr;
          }
        }
        if (!inserted) {
          throw new FriendServiceError('Failed to generate unique friend code', 500);
        }
      }

      await client.query('COMMIT');

      const result = {
        user_id: user.user_id,
        friend_code: user.friend_code,
      };

      if (newlyGeneratedToken) {
        result.auth_token = newlyGeneratedToken;
      }

      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // GET /users/by-code/:code
  async getUserByCode({ code, callerUserId }) {
    const rawCode = (code || '').trim();
    const normalizedCode = normalizeFriendCode(rawCode);

    if (callerUserId) {
      checkLookupRateLimit(callerUserId);
    }

    if (!isValidFriendCode(normalizedCode)) {
      throw new FriendServiceError(
        'Friend codes are 8 letters and numbers',
        400,
        ErrorCodes.BAD_FORMAT
      );
    }

    const { rows } = await pool.query(
      `SELECT user_id, name, profile_image, friend_code
       FROM users
       WHERE friend_code = $1`,
      [normalizedCode]
    );

    if (rows.length === 0) {
      throw new FriendServiceError(
        `No player found with code ${formatFriendCodeWithDash(normalizedCode)}`,
        404,
        ErrorCodes.CODE_NOT_FOUND
      );
    }

    const user = rows[0];

    if (callerUserId && user.user_id.toLowerCase() === callerUserId.toLowerCase()) {
      throw new FriendServiceError(
        "That's your own friend code. Share it with a friend instead.",
        400,
        ErrorCodes.OWN_CODE
      );
    }

    const presence = getUserPresence(user.user_id);

    return {
      user_id: user.user_id,
      name: user.name,
      profile_image: user.profile_image,
      friend_code: user.friend_code,
      is_online: presence.is_online,
      status: presence.status,
      game: presence.game,
    };
  },

  // GET /friends
  async listFriends({ userId }) {
    const normalizedUserId = (userId || '').trim().toLowerCase();

    const { rows } = await pool.query(
      `SELECT u.user_id, u.name, u.profile_image, u.friend_code, f.created_at AS friend_since
       FROM friendships f
       JOIN users u ON (u.user_id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END)
       WHERE f.user_a = $1 OR f.user_b = $1
       ORDER BY f.created_at DESC`,
      [normalizedUserId]
    );

    const friends = rows.map((r) => {
      const presence = getUserPresence(r.user_id);
      return {
        user_id: r.user_id,
        name: r.name,
        profile_image: r.profile_image,
        friend_code: r.friend_code,
        is_online: presence.is_online,
        status: presence.status,
        game: presence.game,
      };
    });

    return friends;
  },

  // POST /friends
  async addFriend({ userId, friendCode, io }) {
    const normalizedUserId = (userId || '').trim().toLowerCase();
    const rawCode = (friendCode || '').trim();
    const normalizedCode = normalizeFriendCode(rawCode);

    if (!isValidFriendCode(normalizedCode)) {
      throw new FriendServiceError(
        'Friend codes are 8 letters and numbers',
        400,
        ErrorCodes.BAD_FORMAT
      );
    }

    // 1. Look up target user by code
    const { rows: targetRows } = await pool.query(
      'SELECT user_id, name, profile_image, friend_code FROM users WHERE friend_code = $1',
      [normalizedCode]
    );

    if (targetRows.length === 0) {
      throw new FriendServiceError(
        `No player found with code ${formatFriendCodeWithDash(normalizedCode)}`,
        404,
        ErrorCodes.CODE_NOT_FOUND
      );
    }

    const targetUser = targetRows[0];
    const targetUserId = targetUser.user_id.toLowerCase();

    // 2. Reject own code
    if (targetUserId === normalizedUserId) {
      throw new FriendServiceError(
        "That's your own friend code. Share it with a friend instead.",
        400,
        ErrorCodes.OWN_CODE
      );
    }

    // 3. Ensure caller exists in users table (auto-create if needed)
    const { rows: callerRows } = await pool.query(
      'SELECT user_id, name, profile_image, friend_code FROM users WHERE user_id = $1',
      [normalizedUserId]
    );
    let callerUser = callerRows[0];
    if (!callerUser) {
      const registered = await this.registerUser({
        userId: normalizedUserId,
        name: 'Player',
        profileImage: 'A1',
      });
      const { rows: refreshed } = await pool.query(
        'SELECT user_id, name, profile_image, friend_code FROM users WHERE user_id = $1',
        [normalizedUserId]
      );
      callerUser = refreshed[0];
    }

    // 4. Check if already friends
    const userA = normalizedUserId < targetUserId ? normalizedUserId : targetUserId;
    const userB = normalizedUserId < targetUserId ? targetUserId : normalizedUserId;

    const { rows: existingPair } = await pool.query(
      'SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2',
      [userA, userB]
    );
    if (existingPair.length > 0) {
      throw new FriendServiceError(
        `You're already friends with ${targetUser.name}`,
        409,
        ErrorCodes.ALREADY_FRIENDS
      );
    }

    // 5. Check friend limits (max 200)
    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*) AS count FROM friendships WHERE user_a = $1 OR user_b = $1',
      [normalizedUserId]
    );
    const callerCount = parseInt(countRows[0].count, 10);
    if (callerCount >= FriendLimits.MAX_FRIENDS) {
      throw new FriendServiceError(
        'You can have up to 200 friends',
        409,
        ErrorCodes.FRIEND_LIMIT_REACHED
      );
    }

    // 6. Insert mutual friendship
    await pool.query(
      `INSERT INTO friendships (user_a, user_b, created_by, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [userA, userB, normalizedUserId]
    );

    // 7. Notify target user via socket (friend:added)
    if (io) {
      const callerPresence = getUserPresence(normalizedUserId);
      const friendAddedPayload = {
        friend: {
          user_id: callerUser.user_id,
          name: callerUser.name,
          profile_image: callerUser.profile_image,
          friend_code: callerUser.friend_code,
          is_online: callerPresence.is_online,
          status: callerPresence.status,
          game: callerPresence.game,
        },
      };

      io.of('/v1').to(`user:${targetUserId}`).emit(SocketEvents.FRIEND_ADDED, friendAddedPayload);
      io.to(`user:${targetUserId}`).emit(SocketEvents.FRIEND_ADDED, friendAddedPayload);
    }

    const targetPresence = getUserPresence(targetUserId);
    return {
      friend: {
        user_id: targetUser.user_id,
        name: targetUser.name,
        profile_image: targetUser.profile_image,
        friend_code: targetUser.friend_code,
        is_online: targetPresence.is_online,
        status: targetPresence.status,
        game: targetPresence.game,
      },
    };
  },

  // DELETE /friends/:user_id
  async removeFriend({ userId, friendUserId, io }) {
    const normalizedUserId = (userId || '').trim().toLowerCase();
    const normalizedTargetId = (friendUserId || '').trim().toLowerCase();

    const userA = normalizedUserId < normalizedTargetId ? normalizedUserId : normalizedTargetId;
    const userB = normalizedUserId < normalizedTargetId ? normalizedTargetId : normalizedUserId;

    const { rows: deletedRows } = await pool.query(
      `DELETE FROM friendships
       WHERE user_a = $1 AND user_b = $2
       RETURNING *`,
      [userA, userB]
    );

    // If friendship existed, notify the other user via friend:removed
    if (deletedRows.length > 0 && io) {
      const payload = { user_id: normalizedUserId };
      io.of('/v1').to(`user:${normalizedTargetId}`).emit(SocketEvents.FRIEND_REMOVED, payload);
      io.to(`user:${normalizedTargetId}`).emit(SocketEvents.FRIEND_REMOVED, payload);
    }

    return true;
  },
};
