import { friendRequestService } from '../services/friend_request.service.js';
import { successResponse, errorResponse } from '../helpers/response.helper.js';

export const friendRequestController = {
  // POST /friend-requests
  async sendRequest(req, res, next) {
    try {
      const { friend_code, user_id, game } = req.body || {};
      const io = req.app.get('io');

      const result = await friendRequestService.sendRequest({
        callerUserId: req.userId,
        friendCode: friend_code,
        targetUserId: user_id,
        game,
        io,
      });

      if (result.autoAccepted) {
        return successResponse(res, result.data, 'OK', 200);
      }
      return successResponse(res, result.data, 'OK', 201);
    } catch (err) {
      if (err.name === 'FriendServiceError') {
        return errorResponse(res, err.message, err.statusCode);
      }
      next(err);
    }
  },

  // GET /friend-requests
  async listRequests(req, res, next) {
    try {
      const data = await friendRequestService.listRequests({
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

  // POST /friend-requests/:request_id/accept
  async acceptRequest(req, res, next) {
    try {
      const requestId = req.params.request_id;
      const io = req.app.get('io');

      const data = await friendRequestService.acceptRequest({
        callerUserId: req.userId,
        requestId,
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

  // POST /friend-requests/:request_id/decline
  async declineRequest(req, res, next) {
    try {
      const requestId = req.params.request_id;
      const io = req.app.get('io');

      await friendRequestService.declineRequest({
        callerUserId: req.userId,
        requestId,
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

  // DELETE /friend-requests/:request_id
  async cancelRequest(req, res, next) {
    try {
      const requestId = req.params.request_id;
      const io = req.app.get('io');

      await friendRequestService.cancelRequest({
        callerUserId: req.userId,
        requestId,
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

