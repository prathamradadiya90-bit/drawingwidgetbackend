import { errorResponse } from '../helpers/response.helper.js';
import { DeviceTypes } from '../helpers/constants.js';
import { pool } from '../config/db.js';
import { verifyDeviceToken } from '../helpers/auth.helper.js';

/**
 * Authentication middleware for HTTP requests
 * Verifies presence of user identification header (x-user-id or userid),
 * normalizes device type (ios or android),
 * and verifies device auth token (x-auth-token) when required.
 */
export const requireUser = async (req, res, next) => {
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

  const rawDeviceId =
    req.headers['x-device-id'] ||
    req.headers['device-id'] ||
    req.headers['x-deviceid'] ||
    req.body?.device_id;
  req.deviceId = typeof rawDeviceId === 'string' && rawDeviceId.trim().length > 0 ? rawDeviceId.trim() : null;

  const rawAuthToken =
    req.headers['x-auth-token'] ||
    req.headers['auth-token'] ||
    req.headers['x-token'];
  req.authToken = typeof rawAuthToken === 'string' && rawAuthToken.trim().length > 0 ? rawAuthToken.trim() : null;

  const isRegisterEndpoint =
    req.path === '/register' ||
    req.path === '/register/' ||
    req.originalUrl?.endsWith('/users/register') ||
    req.originalUrl?.endsWith('/users/register/');

  try {
    const { rows } = await pool.query(
      'SELECT auth_token_hash FROM users WHERE user_id = $1',
      [req.userId]
    );

    const requireAuthToken = process.env.REQUIRE_AUTH_TOKEN === 'true';

    if (rows.length > 0) {
      const userHash = rows[0].auth_token_hash;
      if (userHash) {
        // User has a registered auth token - strict verification required
        if (!req.authToken || !verifyDeviceToken(req.authToken, userHash)) {
          return errorResponse(
            res,
            'Your session is no longer valid. Reinstall the app or contact support.',
            401
          );
        }
      } else if (requireAuthToken && !isRegisterEndpoint) {
        return errorResponse(
          res,
          'Your session is no longer valid. Reinstall the app or contact support.',
          401
        );
      }
    } else if (requireAuthToken && !isRegisterEndpoint) {
      return errorResponse(
        res,
        'Your session is no longer valid. Reinstall the app or contact support.',
        401
      );
    }

    next();
  } catch (err) {
    next(err);
  }
};
