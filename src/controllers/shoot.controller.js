import { shootGameService } from '../services/shoot.service.js';
import { successResponse, errorResponse } from '../helpers/response.helper.js';
import { SocketEvents, ErrorCodes } from '../helpers/constants.js';
import { broadcastShoot } from '../sockets/shoot.events.js';
import { setPlayerInGame, cancelInvitesForGameRoom } from '../services/friend.service.js';

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

export const shootController = {
  /** POST /api/v1/shoot */
  createGame: handle(async (req, res) => {
    const body = req.body || {};
    const result = await shootGameService.createGame({
      name: body.name,
      profileImage: pickProfileImage(body),
      hostId: req.userId,
      deviceType: req.deviceType,
    });
    return successResponse(res, result, 'Game created successfully.', 201);
  }),

  /** POST /api/v1/shoot/join */
  joinGame: handle(async (req, res) => {
    const body = req.body || {};
    const result = await shootGameService.joinGame({
      code: body.code,
      name: body.name,
      profileImage: pickProfileImage(body),
      userId: req.userId,
      deviceType: req.deviceType,
    });

    const io = req.app?.get('io');
    if (io) {
      cancelInvitesForGameRoom(io, { game: 'shoot', roomCode: result.game.code, reason: ErrorCodes.GAME_FULL });
      setPlayerInGame(io, result.game.host_id, 'shoot').catch(() => {});
      setPlayerInGame(io, req.userId, 'shoot').catch(() => {});

      broadcastShoot(io, result.game.id, SocketEvents.SHOOT_PLAYER_JOINED, {
        user_id: req.userId,
        game: result.game,
        players: result.players,
      });
    }

    return successResponse(res, result, 'Joined game successfully.');
  }),

  /** GET /api/v1/shoot/code/:code */
  getGameByCode: handle(async (req, res) => {
    const result = await shootGameService.getGameByCode(req.params.code);
    return successResponse(res, result, 'Game details retrieved.');
  }),

  /** GET /api/v1/shoot/:id */
  getGame: handle(async (req, res) => {
    const result = await shootGameService.getGame(req.params.id);
    return successResponse(res, result, 'Game details retrieved.');
  }),
};

