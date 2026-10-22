import { roomService } from '../services/room.service.js';
import { strokeService } from '../services/stroke.service.js';
import { successResponse, errorResponse } from '../helpers/response.helper.js';

export const roomController = {
  /**
   * Create a new multiplayer room
   * POST /api/v1/rooms/
   */
  async createRoom(req, res, next) {
    try {
      const { svg_resource, player_count = 2, name } = req.body || {};
      const hostId = req.userId;
      const deviceType = req.deviceType;

      const result = await roomService.createRoom({
        svgResource: svg_resource,
        playerCount: player_count,
        name,
        hostId,
        deviceType,
      });

      return successResponse(res, result, 'Room created successfully.', 201);
    } catch (error) {
      if (error.statusCode) {
        return errorResponse(res, error.message, error.statusCode);
      }
      next(error);
    }
  },

  /**
   * Join an existing multiplayer room using room code
   * POST /api/v1/rooms/join
   */
  async joinRoom(req, res, next) {
    try {
      const { code, name } = req.body || {};
      const userId = req.userId;
      const deviceType = req.deviceType;

      const result = await roomService.joinRoom({
        code,
        name,
        userId,
        deviceType,
      });

      return successResponse(res, result, 'Joined room successfully.', 200);
    } catch (error) {
      if (error.statusCode) {
        return errorResponse(res, error.message, error.statusCode);
      }
      next(error);
    }
  },

  /**
   * Leave a multiplayer room
   * POST /api/v1/rooms/leave
   */
  async leaveRoom(req, res, next) {
    try {
      const { room_id } = req.body || {};
      const userId = req.userId;

      const result = await roomService.leaveRoom({
        roomId: room_id,
        userId,
      });

      return successResponse(res, result, 'Left room successfully.', 200);
    } catch (error) {
      if (error.statusCode) {
        return errorResponse(res, error.message, error.statusCode);
      }
      next(error);
    }
  },

  /**
   * Get room metadata and members
   * GET /api/v1/rooms/:id
   */
  async getRoom(req, res, next) {
    try {
      const { id } = req.params;
      const result = await roomService.getRoom(id);

      return successResponse(res, result, 'Room details retrieved.', 200);
    } catch (error) {
      if (error.statusCode) {
        return errorResponse(res, error.message, error.statusCode);
      }
      next(error);
    }
  },

  /**
   * Get all drawn strokes for a room
   * GET /api/v1/rooms/:id/strokes
   */
  async getRoomStrokes(req, res, next) {
    try {
      const { id } = req.params;
      const strokes = await strokeService.listStrokes(id);

      return successResponse(res, { strokes }, 'Room strokes retrieved.', 200);
    } catch (error) {
      if (error.statusCode) {
        return errorResponse(res, error.message, error.statusCode);
      }
      next(error);
    }
  },
};
