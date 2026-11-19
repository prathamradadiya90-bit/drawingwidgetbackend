import { pool } from '../config/db.js';
import { FriendLimits, ErrorCodes, SocketEvents } from '../helpers/constants.js';
import {
  FriendServiceError,
  normalizeFriendCode,
  isValidFriendCode,
  formatFriendCodeWithDash,
  getUserPresence,
  broadcastPresenceToFriends,
} from './friend.service.js';
import { logger } from '../helpers/logger.js';

export const friendRequestService = {
  /**
   * Helper to format a Friend object with presence
   */
  formatFriend(user) {
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

  /**
   * Helper to format a Request object
   */
  formatRequest(row, fromUser, toUser) {
    return {
      request_id: row.id,
      from: {
        user_id: fromUser.user_id,
        name: fromUser.name,
        profile_image: fromUser.profile_image,
        friend_code: fromUser.friend_code,
      },
      to: {
        user_id: toUser.user_id,
        name: toUser.name,
        profile_image: toUser.profile_image,
        friend_code: toUser.friend_code,
      },
      source: row.source,
      game: row.game || null,
      created_at: new Date(row.created_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
    };
  },

  /**
   * Check if two users played together in any game or drawing room in the last 24 hours.
   */
  async playedTogetherInLast24Hours(userId1, userId2) {
    const { rows } = await pool.query(
      `SELECT 1 FROM (
        SELECT kp1.game_id FROM knife_players kp1
        JOIN knife_players kp2 ON kp1.game_id = kp2.game_id
        JOIN knife_games kg ON kg.id = kp1.game_id
        WHERE kp1.user_id = $1 AND kp2.user_id = $2 AND kg.created_at >= NOW() - INTERVAL '24 hours'
        UNION ALL
        SELECT sp1.game_id FROM shoot_players sp1
        JOIN shoot_players sp2 ON sp1.game_id = sp2.game_id
        JOIN shoot_games sg ON sg.id = sp1.game_id
        WHERE sp1.user_id = $1 AND sp2.user_id = $2 AND sg.created_at >= NOW() - INTERVAL '24 hours'
        UNION ALL
        SELECT tp1.game_id FROM ttt_players tp1
        JOIN ttt_players tp2 ON tp1.game_id = tp2.game_id
        JOIN ttt_games tg ON tg.id = tp1.game_id
        WHERE tp1.user_id = $1 AND tp2.user_id = $2 AND tg.created_at >= NOW() - INTERVAL '24 hours'
        UNION ALL
        SELECT rm1.room_id FROM room_members rm1
        JOIN room_members rm2 ON rm1.room_id = rm2.room_id
        JOIN rooms r ON r.id = rm1.room_id
        WHERE rm1.user_id = $1 AND rm2.user_id = $2 AND r.created_at >= NOW() - INTERVAL '24 hours'
      ) matches LIMIT 1`,
      [userId1, userId2]
    );
    return rows.length > 0;
  },

  /**
   * Send a Friend Request (POST /api/v1/friend-requests)
   * Follows the 10 checks in strict order.
   */
  async sendRequest({ callerUserId, friendCode, targetUserId: rawTargetUserId, game, io }) {
    const callerId = (callerUserId || '').trim().toLowerCase();
    const isCodeBody = typeof friendCode === 'string' && friendCode.trim().length > 0;

    let targetUser = null;
    let targetId = null;
    let source = 'code';

    // ----------------------------------------------------
    // CHECK 1: Code well formed (code body only)
    // ----------------------------------------------------
    if (isCodeBody) {
      source = 'code';
      const normalizedCode = normalizeFriendCode(friendCode);
      if (!isValidFriendCode(normalizedCode)) {
        throw new FriendServiceError(
          'Friend codes are 8 letters and numbers',
          400,
          ErrorCodes.BAD_FORMAT
        );
      }

      // ----------------------------------------------------
      // CHECK 2: Player exists (by code)
      // ----------------------------------------------------
      const { rows } = await pool.query(
        'SELECT user_id, name, profile_image, friend_code FROM users WHERE friend_code = $1',
        [normalizedCode]
      );
      if (rows.length === 0) {
        throw new FriendServiceError(
          `No player found with code ${formatFriendCodeWithDash(normalizedCode)}`,
          404,
          ErrorCodes.CODE_NOT_FOUND
        );
      }
      targetUser = rows[0];
      targetId = targetUser.user_id.toLowerCase();
    } else {
      source = 'match';
      targetId = (rawTargetUserId || '').trim().toLowerCase();
      if (!targetId) {
        throw new FriendServiceError('Player not found', 404, ErrorCodes.NOT_FOUND);
      }

      // ----------------------------------------------------
      // CHECK 2: Player exists (by user_id)
      // ----------------------------------------------------
      const { rows } = await pool.query(
        'SELECT user_id, name, profile_image, friend_code FROM users WHERE user_id = $1',
        [targetId]
      );
      if (rows.length === 0) {
        throw new FriendServiceError('Player not found', 404, ErrorCodes.NOT_FOUND);
      }
      targetUser = rows[0];
    }

    // Fetch caller user info
    const { rows: callerRows } = await pool.query(
      'SELECT user_id, name, profile_image, friend_code FROM users WHERE user_id = $1',
      [callerId]
    );
    const callerUser = callerRows[0] || {
      user_id: callerId,
      name: 'Player',
      profile_image: 'A1',
      friend_code: '',
    };

    // ----------------------------------------------------
    // CHECK 3: Not yourself
    // ----------------------------------------------------
    if (targetId === callerId) {
      throw new FriendServiceError(
        "That's your own friend code. Share it with a friend instead.",
        400,
        ErrorCodes.OWN_CODE
      );
    }

    // ----------------------------------------------------
    // CHECK 4: Not already friends
    // ----------------------------------------------------
    const userA = callerId < targetId ? callerId : targetId;
    const userB = callerId < targetId ? targetId : callerId;
    const { rows: friendRows } = await pool.query(
      'SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2',
      [userA, userB]
    );
    if (friendRows.length > 0) {
      throw new FriendServiceError(
        `You're already friends with ${targetUser.name}`,
        409,
        ErrorCodes.ALREADY_FRIENDS
      );
    }

    // ----------------------------------------------------
    // CHECK 5: user_id body only: played together in last 24h
    // ----------------------------------------------------
    if (source === 'match') {
      const playedTogether = await this.playedTogetherInLast24Hours(callerId, targetId);
      if (!playedTogether) {
        throw new FriendServiceError(
          'You can only add players you just played with',
          403,
          'NOT_PLAYED_TOGETHER'
        );
      }
    }

    // ----------------------------------------------------
    // CHECK 6: They already sent you a pending request (Auto-accept)
    // ----------------------------------------------------
    const { rows: incomingReqRows } = await pool.query(
      `SELECT id, from_user_id, to_user_id, source, game, created_at, expires_at
       FROM friend_requests
       WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending' AND expires_at > NOW()
       LIMIT 1`,
      [targetId, callerId]
    );

    if (incomingReqRows.length > 0) {
      const incomingReq = incomingReqRows[0];

      // Check friend limits (max 200)
      const { rows: cCount } = await pool.query(
        'SELECT COUNT(*) AS count FROM friendships WHERE user_a = $1 OR user_b = $1',
        [callerId]
      );
      if (parseInt(cCount[0].count, 10) >= FriendLimits.MAX_FRIENDS) {
        throw new FriendServiceError(
          'You can have up to 200 friends',
          409,
          ErrorCodes.FRIEND_LIMIT_REACHED
        );
      }

      const { rows: tCount } = await pool.query(
        'SELECT COUNT(*) AS count FROM friendships WHERE user_a = $1 OR user_b = $1',
        [targetId]
      );
      if (parseInt(tCount[0].count, 10) >= FriendLimits.MAX_FRIENDS) {
        throw new FriendServiceError(
          `${targetUser.name} can't add more friends`,
          409,
          ErrorCodes.FRIEND_LIMIT_REACHED
        );
      }

      // Create mutual friendship
      await pool.query(
        `INSERT INTO friendships (user_a, user_b, created_by, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [userA, userB, callerId]
      );

      // Update incoming request to accepted
      await pool.query(
        `UPDATE friend_requests
         SET status = 'accepted', responded_at = NOW()
         WHERE id = $1`,
        [incomingReq.id]
      );

      // Remove caller's notification for that request
      const { rows: delNotifs } = await pool.query(
        'DELETE FROM notifications WHERE request_id = $1 RETURNING id',
        [incomingReq.id]
      );

      if (io) {
        if (delNotifs.length > 0) {
          io.of('/v1').to(`user:${callerId}`).emit(SocketEvents.NOTIFICATION_REMOVED, {
            notification_id: delNotifs[0].id,
          });
          io.to(`user:${callerId}`).emit(SocketEvents.NOTIFICATION_REMOVED, {
            notification_id: delNotifs[0].id,
          });
        }

        // To sender (target): friend:request:accepted { request_id, friend }
        const callerFriendObj = this.formatFriend(callerUser);
        const acceptedPayload = {
          request_id: incomingReq.id,
          friend: callerFriendObj,
        };
        io.of('/v1').to(`user:${targetId}`).emit(SocketEvents.FRIEND_REQUEST_ACCEPTED, acceptedPayload);
        io.to(`user:${targetId}`).emit(SocketEvents.FRIEND_REQUEST_ACCEPTED, acceptedPayload);

        // Presence broadcasts
        await broadcastPresenceToFriends(io, callerId, getUserPresence(callerId).status, getUserPresence(callerId).game);
        await broadcastPresenceToFriends(io, targetId, getUserPresence(targetId).status, getUserPresence(targetId).game);
      }

      const targetFriendObj = this.formatFriend(targetUser);
      return {
        autoAccepted: true,
        data: {
          friend: targetFriendObj,
          auto_accepted: true,
        },
      };
    }

    // ----------------------------------------------------
    // CHECK 7: You already have a pending request to them
    // ----------------------------------------------------
    const { rows: pendingOutgoing } = await pool.query(
      `SELECT 1 FROM friend_requests
       WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending' AND expires_at > NOW()`,
      [callerId, targetId]
    );
    if (pendingOutgoing.length > 0) {
      throw new FriendServiceError(
        `You already sent ${targetUser.name} a request`,
        409,
        'ALREADY_SENT_REQUEST'
      );
    }

    // ----------------------------------------------------
    // CHECK 8: Neither side has 200 friends
    // ----------------------------------------------------
    const { rows: callerFriendCount } = await pool.query(
      'SELECT COUNT(*) AS count FROM friendships WHERE user_a = $1 OR user_b = $1',
      [callerId]
    );
    if (parseInt(callerFriendCount[0].count, 10) >= FriendLimits.MAX_FRIENDS) {
      throw new FriendServiceError(
        'You can have up to 200 friends',
        409,
        ErrorCodes.FRIEND_LIMIT_REACHED
      );
    }

    const { rows: targetFriendCount } = await pool.query(
      'SELECT COUNT(*) AS count FROM friendships WHERE user_a = $1 OR user_b = $1',
      [targetId]
    );
    if (parseInt(targetFriendCount[0].count, 10) >= FriendLimits.MAX_FRIENDS) {
      throw new FriendServiceError(
        `${targetUser.name} can't add more friends`,
        409,
        ErrorCodes.FRIEND_LIMIT_REACHED
      );
    }

    // ----------------------------------------------------
    // CHECK 9: They declined your request less than 24 hours ago
    // ----------------------------------------------------
    const { rows: recentDeclined } = await pool.query(
      `SELECT 1 FROM friend_requests
       WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'declined'
         AND responded_at >= NOW() - INTERVAL '24 hours'`,
      [callerId, targetId]
    );
    if (recentDeclined.length > 0) {
      throw new FriendServiceError(
        `You can send ${targetUser.name} another request later`,
        429,
        'DECLINED_COOLDOWN'
      );
    }

    // ----------------------------------------------------
    // CHECK 10: At most 30 requests per sender per hour
    // ----------------------------------------------------
    const { rows: senderRateRows } = await pool.query(
      `SELECT COUNT(*) AS count FROM friend_requests
       WHERE from_user_id = $1 AND created_at >= NOW() - INTERVAL '1 hour'`,
      [callerId]
    );
    if (parseInt(senderRateRows[0].count, 10) >= FriendLimits.REQUEST_RATE_LIMIT_MAX) {
      throw new FriendServiceError(
        'Too many requests. Wait a bit and try again.',
        429,
        'RATE_LIMIT_EXCEEDED'
      );
    }

    // ----------------------------------------------------
    // All checks passed: Insert Request and Notification
    // ----------------------------------------------------
    const cleanGame = game ? (game + '').toLowerCase() : null;

    const { rows: newReqRows } = await pool.query(
      `INSERT INTO friend_requests (from_user_id, to_user_id, source, game, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW() + INTERVAL '7 days')
       RETURNING *`,
      [callerId, targetId, source, cleanGame]
    );
    const newReq = newReqRows[0];

    const { rows: newNotifRows } = await pool.query(
      `INSERT INTO notifications (user_id, type, request_id, created_at)
       VALUES ($1, 'friend_request', $2, $3)
       RETURNING *`,
      [targetId, newReq.id, newReq.created_at]
    );
    const newNotif = newNotifRows[0];

    const requestObj = this.formatRequest(newReq, callerUser, targetUser);
    const notifObj = {
      notification_id: newNotif.id,
      type: 'friend_request',
      created_at: new Date(newNotif.created_at).toISOString(),
      request: requestObj,
    };

    if (io) {
      io.of('/v1').to(`user:${targetId}`).emit(SocketEvents.FRIEND_REQUEST_RECEIVED, { request: requestObj });
      io.to(`user:${targetId}`).emit(SocketEvents.FRIEND_REQUEST_RECEIVED, { request: requestObj });

      io.of('/v1').to(`user:${targetId}`).emit(SocketEvents.NOTIFICATION_NEW, { notification: notifObj });
      io.to(`user:${targetId}`).emit(SocketEvents.NOTIFICATION_NEW, { notification: notifObj });
    }

    return {
      autoAccepted: false,
      data: {
        request: requestObj,
      },
    };
  },

  /**
   * List open requests (GET /api/v1/friend-requests)
   */
  async listRequests({ callerUserId }) {
    const callerId = (callerUserId || '').trim().toLowerCase();

    const { rows } = await pool.query(
      `SELECT fr.id, fr.from_user_id, fr.to_user_id, fr.source, fr.game, fr.status, fr.created_at, fr.expires_at,
              u_from.name AS from_name, u_from.profile_image AS from_avatar, u_from.friend_code AS from_code,
              u_to.name AS to_name, u_to.profile_image AS to_avatar, u_to.friend_code AS to_code
       FROM friend_requests fr
       JOIN users u_from ON u_from.user_id = fr.from_user_id
       JOIN users u_to ON u_to.user_id = fr.to_user_id
       WHERE (fr.from_user_id = $1 OR fr.to_user_id = $1)
         AND fr.status = 'pending'
         AND fr.expires_at > NOW()
       ORDER BY fr.created_at DESC`,
      [callerId]
    );

    const incoming = [];
    const outgoing = [];

    for (const r of rows) {
      const fromUser = {
        user_id: r.from_user_id,
        name: r.from_name,
        profile_image: r.from_avatar,
        friend_code: r.from_code,
      };
      const toUser = {
        user_id: r.to_user_id,
        name: r.to_name,
        profile_image: r.to_avatar,
        friend_code: r.to_code,
      };
      const reqObj = this.formatRequest(r, fromUser, toUser);

      if (r.to_user_id === callerId) {
        incoming.push(reqObj);
      } else {
        outgoing.push(reqObj);
      }
    }

    return { incoming, outgoing };
  },

  /**
   * Accept friend request (POST /api/v1/friend-requests/:request_id/accept)
   */
  async acceptRequest({ callerUserId, requestId, io }) {
    const callerId = (callerUserId || '').trim().toLowerCase();

    const { rows } = await pool.query(
      `SELECT fr.*,
              u_from.name AS from_name, u_from.profile_image AS from_avatar, u_from.friend_code AS from_code,
              u_to.name AS to_name, u_to.profile_image AS to_avatar, u_to.friend_code AS to_code
       FROM friend_requests fr
       JOIN users u_from ON u_from.user_id = fr.from_user_id
       JOIN users u_to ON u_to.user_id = fr.to_user_id
       WHERE fr.id = $1`,
      [requestId]
    );

    if (rows.length === 0) {
      throw new FriendServiceError("You can't change this request", 403);
    }

    const reqRow = rows[0];

    // Only the receiver can accept
    if (reqRow.to_user_id !== callerId) {
      throw new FriendServiceError("You can't change this request", 403);
    }

    // Check status & expiry
    if (reqRow.status !== 'pending' || new Date(reqRow.expires_at) <= new Date()) {
      throw new FriendServiceError('This request is no longer available', 410);
    }

    // Check 200 friend limit for receiver
    const { rows: cCount } = await pool.query(
      'SELECT COUNT(*) AS count FROM friendships WHERE user_a = $1 OR user_b = $1',
      [callerId]
    );
    if (parseInt(cCount[0].count, 10) >= FriendLimits.MAX_FRIENDS) {
      throw new FriendServiceError('You can have up to 200 friends', 409);
    }

    // Check 200 friend limit for sender
    const { rows: sCount } = await pool.query(
      'SELECT COUNT(*) AS count FROM friendships WHERE user_a = $1 OR user_b = $1',
      [reqRow.from_user_id]
    );
    if (parseInt(sCount[0].count, 10) >= FriendLimits.MAX_FRIENDS) {
      throw new FriendServiceError('You can have up to 200 friends', 409);
    }

    // 1. Insert mutual friendship
    const userA = callerId < reqRow.from_user_id ? callerId : reqRow.from_user_id;
    const userB = callerId < reqRow.from_user_id ? reqRow.from_user_id : callerId;

    await pool.query(
      `INSERT INTO friendships (user_a, user_b, created_by, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [userA, userB, callerId]
    );

    // 2. Update request status
    await pool.query(
      `UPDATE friend_requests
       SET status = 'accepted', responded_at = NOW()
       WHERE id = $1`,
      [requestId]
    );

    // 3. Remove receiver's notification
    const { rows: delNotifs } = await pool.query(
      'DELETE FROM notifications WHERE request_id = $1 RETURNING id',
      [requestId]
    );

    const senderUser = {
      user_id: reqRow.from_user_id,
      name: reqRow.from_name,
      profile_image: reqRow.from_avatar,
      friend_code: reqRow.from_code,
    };
    const receiverUser = {
      user_id: reqRow.to_user_id,
      name: reqRow.to_name,
      profile_image: reqRow.to_avatar,
      friend_code: reqRow.to_code,
    };

    if (io) {
      if (delNotifs.length > 0) {
        io.of('/v1').to(`user:${callerId}`).emit(SocketEvents.NOTIFICATION_REMOVED, {
          notification_id: delNotifs[0].id,
        });
        io.to(`user:${callerId}`).emit(SocketEvents.NOTIFICATION_REMOVED, {
          notification_id: delNotifs[0].id,
        });
      }

      // To sender: friend:request:accepted { request_id, friend }
      const receiverFriendObj = this.formatFriend(receiverUser);
      const payload = {
        request_id: requestId,
        friend: receiverFriendObj,
      };
      io.of('/v1').to(`user:${reqRow.from_user_id}`).emit(SocketEvents.FRIEND_REQUEST_ACCEPTED, payload);
      io.to(`user:${reqRow.from_user_id}`).emit(SocketEvents.FRIEND_REQUEST_ACCEPTED, payload);

      // Presence broadcasts
      await broadcastPresenceToFriends(io, callerId, getUserPresence(callerId).status, getUserPresence(callerId).game);
      await broadcastPresenceToFriends(io, reqRow.from_user_id, getUserPresence(reqRow.from_user_id).status, getUserPresence(reqRow.from_user_id).game);
    }

    const senderFriendObj = this.formatFriend(senderUser);
    return { friend: senderFriendObj };
  },

  /**
   * Decline friend request (POST /api/v1/friend-requests/:request_id/decline)
   */
  async declineRequest({ callerUserId, requestId, io }) {
    const callerId = (callerUserId || '').trim().toLowerCase();

    const { rows } = await pool.query(
      'SELECT * FROM friend_requests WHERE id = $1',
      [requestId]
    );

    if (rows.length === 0) {
      throw new FriendServiceError("You can't change this request", 403);
    }

    const reqRow = rows[0];

    // Only receiver can decline
    if (reqRow.to_user_id !== callerId) {
      throw new FriendServiceError("You can't change this request", 403);
    }

    // Check status & expiry
    if (reqRow.status !== 'pending' || new Date(reqRow.expires_at) <= new Date()) {
      throw new FriendServiceError('This request is no longer available', 410);
    }

    // Update status
    await pool.query(
      `UPDATE friend_requests
       SET status = 'declined', responded_at = NOW()
       WHERE id = $1`,
      [requestId]
    );

    // Delete receiver's notification
    const { rows: delNotifs } = await pool.query(
      'DELETE FROM notifications WHERE request_id = $1 RETURNING id',
      [requestId]
    );

    if (io) {
      if (delNotifs.length > 0) {
        io.of('/v1').to(`user:${callerId}`).emit(SocketEvents.NOTIFICATION_REMOVED, {
          notification_id: delNotifs[0].id,
        });
        io.to(`user:${callerId}`).emit(SocketEvents.NOTIFICATION_REMOVED, {
          notification_id: delNotifs[0].id,
        });
      }

      // To sender: friend:request:ended { request_id, reason: "DECLINED" }
      const payload = { request_id: requestId, reason: 'DECLINED' };
      io.of('/v1').to(`user:${reqRow.from_user_id}`).emit(SocketEvents.FRIEND_REQUEST_ENDED, payload);
      io.to(`user:${reqRow.from_user_id}`).emit(SocketEvents.FRIEND_REQUEST_ENDED, payload);
    }

    return null;
  },

  /**
   * Cancel friend request (DELETE /api/v1/friend-requests/:request_id)
   */
  async cancelRequest({ callerUserId, requestId, io }) {
    const callerId = (callerUserId || '').trim().toLowerCase();

    const { rows } = await pool.query(
      'SELECT * FROM friend_requests WHERE id = $1',
      [requestId]
    );

    if (rows.length === 0) {
      throw new FriendServiceError("You can't change this request", 403);
    }

    const reqRow = rows[0];

    // Only sender can cancel
    if (reqRow.from_user_id !== callerId) {
      throw new FriendServiceError("You can't change this request", 403);
    }

    // Check status & expiry
    if (reqRow.status !== 'pending' || new Date(reqRow.expires_at) <= new Date()) {
      throw new FriendServiceError('This request is no longer available', 410);
    }

    // Update status
    await pool.query(
      `UPDATE friend_requests
       SET status = 'cancelled', responded_at = NOW()
       WHERE id = $1`,
      [requestId]
    );

    // Delete receiver's notification
    const { rows: delNotifs } = await pool.query(
      'DELETE FROM notifications WHERE request_id = $1 RETURNING id',
      [requestId]
    );

    if (io) {
      if (delNotifs.length > 0) {
        io.of('/v1').to(`user:${reqRow.to_user_id}`).emit(SocketEvents.NOTIFICATION_REMOVED, {
          notification_id: delNotifs[0].id,
        });
        io.to(`user:${reqRow.to_user_id}`).emit(SocketEvents.NOTIFICATION_REMOVED, {
          notification_id: delNotifs[0].id,
        });
      }

      // To receiver: friend:request:ended { request_id, reason: "CANCELLED" }
      const payload = { request_id: requestId, reason: 'CANCELLED' };
      io.of('/v1').to(`user:${reqRow.to_user_id}`).emit(SocketEvents.FRIEND_REQUEST_ENDED, payload);
      io.to(`user:${reqRow.to_user_id}`).emit(SocketEvents.FRIEND_REQUEST_ENDED, payload);
    }

    return null;
  },

  /**
   * Periodic expiry job:
   * Sets pending requests past expires_at to 'expired',
   * removes notifications, and emits friend:request:ended EXPIRED to both sides.
   */
  async sweepExpiredRequests(io) {
    try {
      const { rows: expiredRequests } = await pool.query(
        `UPDATE friend_requests
         SET status = 'expired', responded_at = NOW()
         WHERE status = 'pending' AND expires_at <= NOW()
         RETURNING id, from_user_id, to_user_id`
      );

      for (const req of expiredRequests) {
        // Delete notification
        const { rows: delNotifs } = await pool.query(
          'DELETE FROM notifications WHERE request_id = $1 RETURNING id',
          [req.id]
        );

        if (io) {
          if (delNotifs.length > 0) {
            io.of('/v1').to(`user:${req.to_user_id}`).emit(SocketEvents.NOTIFICATION_REMOVED, {
              notification_id: delNotifs[0].id,
            });
            io.to(`user:${req.to_user_id}`).emit(SocketEvents.NOTIFICATION_REMOVED, {
              notification_id: delNotifs[0].id,
            });
          }

          // friend:request:ended EXPIRED to BOTH users
          const payload = { request_id: req.id, reason: 'EXPIRED' };
          io.of('/v1').to(`user:${req.from_user_id}`).emit(SocketEvents.FRIEND_REQUEST_ENDED, payload);
          io.to(`user:${req.from_user_id}`).emit(SocketEvents.FRIEND_REQUEST_ENDED, payload);

          io.of('/v1').to(`user:${req.to_user_id}`).emit(SocketEvents.FRIEND_REQUEST_ENDED, payload);
          io.to(`user:${req.to_user_id}`).emit(SocketEvents.FRIEND_REQUEST_ENDED, payload);
        }
      }

      // Purge notifications older than 7 days
      const { rows: oldNotifs } = await pool.query(
        `DELETE FROM notifications
         WHERE created_at < NOW() - INTERVAL '7 days'
         RETURNING id, user_id`
      );

      if (io && oldNotifs.length > 0) {
        for (const notif of oldNotifs) {
          io.of('/v1').to(`user:${notif.user_id}`).emit(SocketEvents.NOTIFICATION_REMOVED, {
            notification_id: notif.id,
          });
          io.to(`user:${notif.user_id}`).emit(SocketEvents.NOTIFICATION_REMOVED, {
            notification_id: notif.id,
          });
        }
      }

      return { expiredCount: expiredRequests.length, purgedNotifs: oldNotifs.length };
    } catch (err) {
      logger.error('Failed to sweep expired friend requests / notifications:', err);
      return { expiredCount: 0, purgedNotifs: 0 };
    }
  },
};
