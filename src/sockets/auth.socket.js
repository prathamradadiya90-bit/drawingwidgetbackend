import { DeviceTypes, SocketLimits } from '../helpers/constants.js';
import { logger } from '../helpers/logger.js';
import { pool } from '../config/db.js';
import { verifyDeviceToken } from '../helpers/auth.helper.js';

/**
 * Socket.IO authentication middleware
 * Extracts userId, deviceType, and token from handshake.
 * Verifies auth token if user has one stored.
 */
export const socketAuth = async (socket, next) => {
  try {
    const { auth, query, headers } = socket.handshake;

    const rawUserId =
      headers?.['x-user-id'] ||
      headers?.userid ||
      headers?.['user-id'] ||
      auth?.userId ||
      auth?.userid ||
      query?.userId ||
      query?.userid;

    if (!rawUserId || typeof rawUserId !== 'string' || rawUserId.trim().length < 2) {
      return next(new Error('Unauthorized: Valid userId is required.'));
    }

    const userId = rawUserId.trim().toLowerCase();

    const rawToken =
      auth?.token ||
      query?.token ||
      headers?.['x-auth-token'] ||
      headers?.['auth-token'] ||
      headers?.['x-token'];

    const token = typeof rawToken === 'string' && rawToken.trim().length > 0 ? rawToken.trim() : null;

    // Check user auth token hash in DB
    const { rows } = await pool.query(
      'SELECT auth_token_hash FROM users WHERE user_id = $1',
      [userId]
    );

    const requireAuthToken = process.env.REQUIRE_AUTH_TOKEN === 'true';

    if (rows.length > 0) {
      const storedHash = rows[0].auth_token_hash;
      if (storedHash) {
        if (!token || !verifyDeviceToken(token, storedHash)) {
          return next(new Error('Unauthorized: invalid token'));
        }
      } else if (requireAuthToken) {
        return next(new Error('Unauthorized: invalid token'));
      }
    } else if (requireAuthToken) {
      return next(new Error('Unauthorized: invalid token'));
    }

    const rawDeviceType =
      headers?.devicetype ||
      headers?.['device-type'] ||
      query?.devicetype ||
      auth?.devicetype;

    const deviceType =
      typeof rawDeviceType === 'string' && rawDeviceType.toLowerCase().trim() === DeviceTypes.ANDROID
        ? DeviceTypes.ANDROID
        : DeviceTypes.IOS;

    const rawName =
      headers?.['x-user-name'] ||
      headers?.name ||
      auth?.name ||
      auth?.userName ||
      auth?.username ||
      query?.name;

    const rawProfileImage =
      headers?.['x-profile-image'] ||
      headers?.['x-avatar-url'] ||
      auth?.profileImage ||
      auth?.profile_image ||
      auth?.avatarUrl ||
      auth?.avatar_url ||
      auth?.avatar ||
      query?.profileImage ||
      query?.profile_image;

    socket.data = {
      userId,
      authToken: token,
      deviceType,
      name: typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : null,
      profileImage: typeof rawProfileImage === 'string' && rawProfileImage.trim().length > 0 ? rawProfileImage.trim() : null,
      rate: {
        tokens: SocketLimits.BURST,
        last: Date.now(),
      },
      actionRate: {
        tokens: SocketLimits.BURST,
        last: Date.now(),
      },
      moveRate: {
        tokens: SocketLimits.MOVE_BURST,
        last: Date.now(),
      },
    };

    next();
  } catch (error) {
    logger.error('Socket authentication error:', error);
    next(new Error('Unauthorized: Authentication error occurred.'));
  }
};
