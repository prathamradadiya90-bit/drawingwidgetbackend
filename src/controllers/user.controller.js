import { friendService } from '../services/friend.service.js';
import { successResponse, errorResponse } from '../helpers/response.helper.js';

export const userController = {
  // POST /users/register
  async register(req, res, next) {
    try {
      const { name, profile_image, platform, device_id } = req.body || {};
      const data = await friendService.registerUser({
        userId: req.userId,
        deviceId: device_id || req.deviceId,
        name,
        profileImage: profile_image,
        platform: platform || req.deviceType,
      });
      return successResponse(res, data, 'OK', 200);
    } catch (err) {
      if (err.name === 'FriendServiceError') {
        return errorResponse(res, err.message, err.statusCode);
      }
      next(err);
    }
  },

  // GET /users/by-code/:code
  async getByCode(req, res, next) {
    try {
      const code = req.params.code;
      const data = await friendService.getUserByCode({
        code,
        callerUserId: req.userId,
      });
      return successResponse(res, data, 'OK', 200);
    } catch (err) {
      if (err.name === 'FriendServiceError') {
        return errorResponse(res, err.message, err.statusCode);
      }
      next(err);
    }
  },
};

