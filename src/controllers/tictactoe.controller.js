import { ticTacToeService } from '../services/tictactoe.service.js';
import { successResponse, errorResponse } from '../helpers/response.helper.js';
import { ErrorCodes } from '../helpers/constants.js';
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

export const ticTacToeController = {
  /** POST /api/v1/tictactoe */
  createGame: handle(async (req, res) => {
    const body = req.body || {};
    const result = await ticTacToeService.createGame({
      name: body.name,
      profileImage: pickProfileImage(body),
      hostId: req.userId,
      deviceType: req.deviceType,
    });
    return successResponse(res, result, 'Game created successfully.', 201);
  }),

  /** POST /api/v1/tictactoe/join */
  joinGame: handle(async (req, res) => {
    const body = req.body || {};
    const result = await ticTacToeService.joinGame({
      code: body.code,
      name: body.name,
      profileImage: pickProfileImage(body),
      userId: req.userId,
      deviceType: req.deviceType,
    });

    const io = req.app?.get('io');
    if (io) {
      cancelInvitesForGameRoom(io, { game: 'tictactoe', roomCode: result.game.code, reason: ErrorCodes.GAME_FULL });
      setPlayerInGame(io, result.game.host_id, 'tictactoe').catch(() => {});
      setPlayerInGame(io, req.userId, 'tictactoe').catch(() => {});
    }

    return successResponse(res, result, 'Joined game successfully.');
  }),

  /** GET /api/v1/tictactoe/code/:code */
  getGameByCode: handle(async (req, res) => {
    const result = await ticTacToeService.getGameByCode(req.params.code);
    return successResponse(res, result, 'Game details retrieved.');
  }),

  /** GET /api/v1/tictactoe/:id */
  getGame: handle(async (req, res) => {
    const result = await ticTacToeService.getGame(req.params.id);
    return successResponse(res, result, 'Game details retrieved.');
  }),

  /** GET /api/v1/tictactoe/:id/moves */
  getMoves: handle(async (req, res) => {
    const moves = await ticTacToeService.listMoves(req.params.id);
    return successResponse(res, { moves }, 'Game moves retrieved.');
  }),
};
