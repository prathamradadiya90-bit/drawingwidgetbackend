import { SocketEvents, SocketLimits, ErrorCodes, TicTacToe } from '../helpers/constants.js';
import { ticTacToeService } from '../services/tictactoe.service.js';
import { setPlayerInGame, clearPlayerInGame, cancelInvitesForGameRoom } from '../services/friend.service.js';
import { sendSocketError } from './events.js';
import { takeToken } from './rateLimiter.js';
import { logger } from '../helpers/logger.js';

const { GameStatus, EndReason } = TicTacToe;

// Forfeit timers for players who dropped mid-game: key `${gameId}:${userId}`
const forfeitTimers = new Map();

const gameChannel = (gameId) => `ttt:${gameId}`;

// Clients connect on "/" or "/v1", and opponents may be on different namespaces.
const namespacesOf = (io) => [io.of('/'), io.of('/v1')];

function broadcast(io, gameId, event, payload, exceptSocketId) {
  for (const nsp of namespacesOf(io)) {
    const target = nsp.to(gameChannel(gameId));
    (exceptSocketId ? target.except(exceptSocketId) : target).emit(event, payload);
  }
}

async function isUserConnected(io, gameId, userId, exceptSocketId) {
  const sockets = await Promise.all(
    namespacesOf(io).map((nsp) => nsp.in(gameChannel(gameId)).fetchSockets())
  );
  return sockets.flat().some((s) => s.id !== exceptSocketId && s.data.userId === userId);
}

function cancelForfeit(gameId, userId) {
  const key = `${gameId}:${userId}`;
  clearTimeout(forfeitTimers.get(key));
  forfeitTimers.delete(key);
}

function announceGameOver(io, game, winnerUserId) {
  if (winnerUserId) clearPlayerInGame(io, winnerUserId);
  broadcast(io, game.id, SocketEvents.TTT_GAME_OVER, {
    game_id: game.id,
    status: game.status,
    winner: game.winner,
    winner_user_id: winnerUserId,
    winning_line: game.winning_line,
    is_draw: game.is_draw,
    reason: game.end_reason,
    board: game.board,
  });
}

function announceLeave(io, result, userId, exceptSocketId) {
  clearPlayerInGame(io, userId);
  broadcast(
    io,
    result.game.id,
    SocketEvents.TTT_PLAYER_LEFT,
    { game_id: result.game.id, user_id: userId },
    exceptSocketId
  );
  if (result.game.end_reason && result.abandoned) {
    announceGameOver(io, result.game, result.winnerUserId);
  }
}

function armForfeit(io, gameId, userId) {
  if (forfeitTimers.has(`${gameId}:${userId}`)) return;

  const timer = setTimeout(async () => {
    forfeitTimers.delete(`${gameId}:${userId}`);
    try {
      const result = await ticTacToeService.leaveGame({
        gameId,
        userId,
        reason: EndReason.OPPONENT_DISCONNECTED,
      });
      announceLeave(io, result, userId);
    } catch (err) {
      // The player may have left, or the game may have been reaped, in the meantime.
      if (!err.statusCode) logger.error(`Failed to forfeit Tic Tac Toe game ${gameId}:`, err);
    }
  }, SocketLimits.TTT_FORFEIT_TIMEOUT_MS);
  timer.unref();

  forfeitTimers.set(`${gameId}:${userId}`, timer);
}

export function registerTicTacToeEvents(socket, io) {
  const { userId } = socket.data;

  /** Runs a handler with rate limiting and uniform errors; `failureCode` labels rejected actions. */
  const on = (event, failureCode, handler) => {
    socket.on(event, async (payload, ack) => {
      if (!takeToken(socket.data.actionRate, SocketLimits.RATE_PER_SEC, SocketLimits.BURST)) {
        sendSocketError(socket, event, ErrorCodes.RATE_LIMIT_EXCEEDED, 'Too many requests', ack);
        return;
      }
      try {
        await handler(payload && typeof payload === 'object' ? payload : {}, ack);
      } catch (err) {
        if (err.statusCode && err.statusCode < 500) {
          sendSocketError(socket, event, failureCode ?? err.reason, err.message, ack, {
            reason: err.reason,
          });
          return;
        }
        logger.error(`Unexpected error in ${event} handler:`, err);
        sendSocketError(socket, event, ErrorCodes.SAVE_FAILED, 'Something went wrong', ack);
      }
    });
  };

  const requireJoinedGame = () => {
    const gameId = socket.data.tttGameId;
    if (!gameId) {
      const error = new Error('Join a game first');
      error.statusCode = 409;
      error.reason = ErrorCodes.NOT_IN_GAME;
      throw error;
    }
    return gameId;
  };

  on(SocketEvents.TTT_GAME_JOIN, null, async ({ game_id: gameId }, ack) => {
    const { game, players, symbol } = await ticTacToeService.getSeat({ gameId, userId });

    if (socket.data.tttGameId && socket.data.tttGameId !== gameId) {
      socket.leave(gameChannel(socket.data.tttGameId));
    }
    socket.join(gameChannel(gameId));
    socket.data.tttGameId = gameId;
    cancelForfeit(gameId, userId);

    if (typeof ack === 'function') ack({ ok: true, your_symbol: symbol, game, players });
    broadcast(
      io,
      gameId,
      SocketEvents.TTT_PLAYER_JOINED,
      { game_id: gameId, user_id: userId, game, players },
      socket.id
    );

    // A joined opponent who never connects must not leave this player waiting forever.
    if (game.status === GameStatus.PLAYING) {
      cancelInvitesForGameRoom(io, { game: 'tictactoe', roomCode: game.code });
      setPlayerInGame(io, userId, 'tictactoe');
      const opponent = players.find((player) => player.user_id !== userId);
      if (opponent) {
        setPlayerInGame(io, opponent.user_id, 'tictactoe');
        if (!(await isUserConnected(io, gameId, opponent.user_id))) {
          armForfeit(io, gameId, opponent.user_id);
        }
      }
    }
  });

  on(SocketEvents.TTT_MOVE, ErrorCodes.MOVE_FAILED, async ({ cell_index: cellIndex }, ack) => {
    const gameId = requireJoinedGame();
    const { game, symbol, moveNumber, winnerUserId } = await ticTacToeService.makeMove({
      gameId,
      userId,
      cellIndex,
    });

    const isOver = game.status === GameStatus.FINISHED;
    const move = {
      game_id: gameId,
      user_id: userId,
      cell_index: cellIndex,
      symbol,
      move_number: moveNumber,
      next_turn: game.current_turn,
      board: game.board,
      game_over: isOver,
      winner: game.winner,
      winning_line: game.winning_line,
      is_draw: game.is_draw,
    };

    if (typeof ack === 'function') ack({ ok: true, ...move });
    broadcast(io, gameId, SocketEvents.TTT_MOVE_MADE, move, socket.id);
    if (isOver) announceGameOver(io, game, winnerUserId);
  });

  on(SocketEvents.TTT_RESTART, ErrorCodes.RESTART_FAILED, async (_payload, ack) => {
    const gameId = requireJoinedGame();
    const { game, players, symbol } = await ticTacToeService.restartGame({ gameId, userId });

    if (typeof ack === 'function') {
      ack({
        ok: true,
        status: game.status,
        move_count: game.move_count,
        your_symbol: symbol,
        game,
        players,
      });
    }
    broadcast(
      io,
      gameId,
      SocketEvents.TTT_GAME_RESTARTED,
      { game_id: gameId, restarted_by: userId, game, players },
      socket.id
    );
  });

  on(SocketEvents.TTT_GAME_LEAVE, null, async (_payload, ack) => {
    const gameId = requireJoinedGame();
    cancelForfeit(gameId, userId);
    const result = await ticTacToeService.leaveGame({ gameId, userId });
    if (result.abandoned && result.game.host_id === userId) {
      cancelInvitesForGameRoom(io, { game: 'tictactoe', roomCode: result.game.code, reason: ErrorCodes.HOST_LEFT });
    }

    socket.leave(gameChannel(gameId));
    socket.data.tttGameId = null;

    if (typeof ack === 'function') ack({ ok: true, game_abandoned: result.abandoned });
    announceLeave(io, result, userId);
  });

  socket.on('disconnect', async () => {
    const gameId = socket.data.tttGameId;
    if (!gameId) return;

    try {
      if (await isUserConnected(io, gameId, userId, socket.id)) return;

      broadcast(io, gameId, SocketEvents.TTT_PLAYER_DISCONNECTED, {
        game_id: gameId,
        user_id: userId,
        timeout_ms: SocketLimits.TTT_FORFEIT_TIMEOUT_MS,
      });

      // Hosts often background the app to share the code, so a waiting game survives a drop.
      const { game } = await ticTacToeService.getGame(gameId);
      if (game.status === GameStatus.PLAYING || game.status === GameStatus.FINISHED) {
        armForfeit(io, gameId, userId);
      }
    } catch (err) {
      if (!err.statusCode) logger.error('Error handling Tic Tac Toe disconnect:', err);
    }
  });
}
