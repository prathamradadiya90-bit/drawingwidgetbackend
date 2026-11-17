import { knifeGameService } from '../services/knife.service.js';
import { successResponse, errorResponse } from '../helpers/response.helper.js';
import { SocketEvents } from '../helpers/constants.js';
import { broadcastKnife } from '../sockets/knife.events.js';

const pickProfileImage = ({ profile_image, profileImage, avatar_url, avatarUrl, avatar }) =>
  profile_image || profileImage || avatar_url || avatarUrl || avatar || null;

/** Wraps a handler so service errors become their HTTP status and the rest reach the error middleware. */
const handle = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (error) {
    if (error.statusCode) {
      return errorResponse(res, error.message, error.statusCode);
    }
    next(error);
  }
};

export const knifeController = {
  /** POST /api/v1/knife */
  createGame: handle(async (req, res) => {
    const body = req.body || {};
    const result = await knifeGameService.createGame({
      name: body.name,
      profileImage: pickProfileImage(body),
      hostId: req.userId,
      deviceType: req.deviceType,
    });
    return successResponse(res, result, 'Game created successfully.', 201);
  }),

  /** POST /api/v1/knife/join */
  joinGame: handle(async (req, res) => {
    const body = req.body || {};
    const result = await knifeGameService.joinGame({
      code: body.code,
      name: body.name,
      profileImage: pickProfileImage(body),
      userId: req.userId,
      deviceType: req.deviceType,
    });

    const io = req.app?.get('io');
    if (io) {
      broadcastKnife(io, result.game.id, SocketEvents.KNIFE_PLAYER_JOINED, {
        game: result.game,
        players: result.players,
      });
    }

    return successResponse(res, result, 'Joined game successfully.');
  }),

  /** GET /api/v1/knife/code/:code */
  getGameByCode: handle(async (req, res) => {
    const result = await knifeGameService.getGameByCode(req.params.code);
    return successResponse(res, result, 'Game details retrieved.');
  }),

  /** GET /api/v1/knife/:id */
  getGame: handle(async (req, res) => {
    const result = await knifeGameService.getGame(req.params.id);
    return successResponse(res, result, 'Game details retrieved.');
  }),
};

