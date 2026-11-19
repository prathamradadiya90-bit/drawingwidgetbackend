import { friendService } from '../services/friend.service.js';
import { successResponse, errorResponse } from '../helpers/response.helper.js';

export const friendController = {
  // GET /friends
  async list(req, res, next) {
    try {
      const friends = await friendService.listFriends({
        userId: req.userId,
      });
      return successResponse(res, { friends }, 'OK', 200);
    } catch (err) {
      if (err.name === 'FriendServiceError') {
        return errorResponse(res, err.message, err.statusCode);
      }
      next(err);
    }
  },

  // POST /friends
  async add(req, res, next) {
    try {
      const { friend_code } = req.body || {};
      const io = req.app.get('io');
      const data = await friendService.addFriend({
        userId: req.userId,
        friendCode: friend_code,
        io,
      });
      return successResponse(res, data, 'OK', 200);
    } catch (err) {
      if (err.name === 'FriendServiceError') {
        return errorResponse(res, err.message, err.statusCode);
      }
      next(err);
    }
  },

  // DELETE /friends/:user_id
  async remove(req, res, next) {
    try {
      const friendUserId = req.params.user_id;
      const io = req.app.get('io');
      await friendService.removeFriend({
        userId: req.userId,
        friendUserId,
        io,
      });
      return successResponse(res, null, 'OK', 200);
    } catch (err) {
      if (err.name === 'FriendServiceError') {
        return errorResponse(res, err.message, err.statusCode);
      }
      next(err);
    }
  },
};

