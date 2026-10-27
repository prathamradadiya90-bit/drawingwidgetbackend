import { DeviceTypes, SocketLimits } from '../helpers/constants.js';
import { logger } from '../helpers/logger.js';

/**
 * Socket.IO authentication middleware
 * Extracts userId and deviceType from handshake
 */
export const socketAuth = (socket, next) => {
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
      userId: rawUserId.trim().toLowerCase(),
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
