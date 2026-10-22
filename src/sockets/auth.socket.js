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

    socket.data = {
      userId: rawUserId.trim().toLowerCase(),
      deviceType,
      rate: {
        tokens: SocketLimits.BURST,
        last: Date.now(),
      },
    };

    next();
  } catch (error) {
    logger.error('Socket authentication error:', error);
    next(new Error('Unauthorized: Authentication error occurred.'));
  }
};
