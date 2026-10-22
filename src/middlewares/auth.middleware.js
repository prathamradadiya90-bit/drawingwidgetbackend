import { errorResponse } from '../helpers/response.helper.js';
import { DeviceTypes } from '../helpers/constants.js';

/**
 * Authentication middleware for HTTP requests
 * Verifies presence of user identification header (x-user-id or userid)
 * and normalizes device type (ios or android).
 */
export const requireUser = (req, res, next) => {
  const userId =
    req.headers['x-user-id'] ||
    req.headers['userid'] ||
    req.headers['user-id'];

  if (!userId || typeof userId !== 'string' || userId.trim().length < 2) {
    return errorResponse(res, 'Missing or invalid user id header (x-user-id)', 401);
  }

  const rawDeviceType = (req.headers['devicetype'] || req.headers['device-type'])?.toLowerCase()?.trim();
  const deviceType = rawDeviceType || DeviceTypes.IOS;

  if (deviceType !== DeviceTypes.IOS && deviceType !== DeviceTypes.ANDROID) {
    return errorResponse(res, `Invalid devicetype. Must be '${DeviceTypes.IOS}' or '${DeviceTypes.ANDROID}'.`, 400);
  }

  req.userId = userId.trim().toLowerCase();
  req.deviceType = deviceType;
  next();
};
