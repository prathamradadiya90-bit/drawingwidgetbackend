import { pool } from '../config/db.js';
import { SocketEvents, FriendLimits } from '../helpers/constants.js';
import { logger } from '../helpers/logger.js';

export const notificationService = {
  /**
   * Record a missed invite notification with 30-minute deduplication window.
   */
  async recordMissedInvite(io, { toUserId, fromUserId, game, reason }) {
    const targetId = (toUserId || '').trim().toLowerCase();
    const senderId = (fromUserId || '').trim().toLowerCase();
    const cleanGame = (game || '').trim().toLowerCase();
    const cleanReason = reason === 'OFFLINE' ? 'OFFLINE' : 'NO_ANSWER';

    try {
      // 1. Check for unacknowledged missed_invite within last 30 minutes
      const { rows: existing } = await pool.query(
        `SELECT id FROM notifications
         WHERE user_id = $1
           AND from_user_id = $2
           AND game = $3
           AND type = 'missed_invite'
           AND created_at >= NOW() - INTERVAL '30 minutes'
         ORDER BY created_at DESC
         LIMIT 1`,
        [targetId, senderId, cleanGame]
      );

      let notifRow = null;
      if (existing.length > 0) {
        const { rows: updated } = await pool.query(
          `UPDATE notifications
           SET created_at = NOW(), reason = $2
           WHERE id = $1
           RETURNING *`,
          [existing[0].id, cleanReason]
        );
        notifRow = updated[0];
      } else {
        const { rows: inserted } = await pool.query(
          `INSERT INTO notifications (user_id, type, from_user_id, game, reason, created_at)
           VALUES ($1, 'missed_invite', $2, $3, $4, NOW())
           RETURNING *`,
          [targetId, senderId, cleanGame, cleanReason]
        );
        notifRow = inserted[0];
      }

      // 2. Fetch sender profile
      const { rows: senderRows } = await pool.query(
        'SELECT user_id, name, profile_image, friend_code FROM users WHERE user_id = $1',
        [senderId]
      );
      const sender = senderRows[0] || {
        user_id: senderId,
        name: 'Friend',
        profile_image: 'A1',
        friend_code: '',
      };

      const notifObj = {
        notification_id: notifRow.id,
        type: 'missed_invite',
        created_at: new Date(notifRow.created_at).toISOString(),
        invite: {
          from: {
            user_id: sender.user_id,
            name: sender.name,
            profile_image: sender.profile_image,
            friend_code: sender.friend_code,
          },
          game: notifRow.game,
          reason: notifRow.reason,
        },
      };

      // 3. Emit notification:new to user room
      if (io) {
        io.of('/v1').to(`user:${targetId}`).emit(SocketEvents.NOTIFICATION_NEW, { notification: notifObj });
        io.to(`user:${targetId}`).emit(SocketEvents.NOTIFICATION_NEW, { notification: notifObj });
      }

      return notifObj;
    } catch (err) {
      logger.error('Failed to record missed invite notification:', err);
      return null;
    }
  },

  /**
   * List notifications for a user within the last 7 days.
   * Only returns active items (pending requests, unacknowledged missed invites).
   */
  async listNotifications({ userId }) {
    const normalizedUserId = (userId || '').trim().toLowerCase();

    // Query notifications created in last 7 days
    const { rows } = await pool.query(
      `SELECT n.id, n.type, n.request_id, n.from_user_id, n.game, n.reason, n.created_at,
              fr.status AS request_status, fr.expires_at AS request_expires_at, fr.source AS request_source, fr.game AS request_game, fr.created_at AS request_created_at,
              u_from.user_id AS from_uid, u_from.name AS from_name, u_from.profile_image AS from_avatar, u_from.friend_code AS from_code,
              u_to.user_id AS to_uid, u_to.name AS to_name, u_to.profile_image AS to_avatar, u_to.friend_code AS to_code
       FROM notifications n
       LEFT JOIN friend_requests fr ON n.request_id = fr.id
       LEFT JOIN users u_from ON u_from.user_id = COALESCE(n.from_user_id, fr.from_user_id)
       LEFT JOIN users u_to ON u_to.user_id = fr.to_user_id
       WHERE n.user_id = $1
         AND n.created_at >= NOW() - INTERVAL '7 days'
       ORDER BY n.created_at DESC`,
      [normalizedUserId]
    );

    const notifications = [];

    for (const r of rows) {
      if (r.type === 'missed_invite') {
        notifications.push({
          notification_id: r.id,
          type: 'missed_invite',
          created_at: new Date(r.created_at).toISOString(),
          invite: {
            from: {
              user_id: r.from_uid || r.from_user_id,
              name: r.from_name || 'Friend',
              profile_image: r.from_avatar || 'A1',
              friend_code: r.from_code || '',
            },
            game: r.game,
            reason: r.reason,
          },
        });
      } else if (r.type === 'friend_request') {
        // Only return if request is still pending and not expired
        if (r.request_status === 'pending' && new Date(r.request_expires_at) > new Date()) {
          notifications.push({
            notification_id: r.id,
            type: 'friend_request',
            created_at: new Date(r.created_at).toISOString(),
            request: {
              request_id: r.request_id,
              from: {
                user_id: r.from_uid,
                name: r.from_name || 'Player',
                profile_image: r.from_avatar || 'A1',
                friend_code: r.from_code || '',
              },
              to: {
                user_id: r.to_uid,
                name: r.to_name || 'Player',
                profile_image: r.to_avatar || 'A1',
                friend_code: r.to_code || '',
              },
              source: r.request_source,
              game: r.request_game,
              created_at: new Date(r.request_created_at).toISOString(),
              expires_at: new Date(r.request_expires_at).toISOString(),
            },
          });
        }
      }
    }

    return notifications;
  },

  /**
   * Acknowledge missed_invite notifications.
   * friend_request notifications are skipped (they leave only when answered or ended).
   */
  async acknowledgeNotifications({ userId, notificationIds, all, io }) {
    const normalizedUserId = (userId || '').trim().toLowerCase();

    let deletedRows = [];

    if (all === true) {
      const { rows } = await pool.query(
        `DELETE FROM notifications
         WHERE user_id = $1 AND type = 'missed_invite'
         RETURNING id`,
        [normalizedUserId]
      );
      deletedRows = rows;
    } else if (Array.isArray(notificationIds) && notificationIds.length > 0) {
      const { rows } = await pool.query(
        `DELETE FROM notifications
         WHERE user_id = $1 AND type = 'missed_invite' AND id = ANY($2)
         RETURNING id`,
        [normalizedUserId, notificationIds]
      );
      deletedRows = rows;
    }

    if (io && deletedRows.length > 0) {
      for (const row of deletedRows) {
        const payload = { notification_id: row.id };
        io.of('/v1').to(`user:${normalizedUserId}`).emit(SocketEvents.NOTIFICATION_REMOVED, payload);
        io.to(`user:${normalizedUserId}`).emit(SocketEvents.NOTIFICATION_REMOVED, payload);
      }
    }

    return { removed: deletedRows.length };
  },
};

