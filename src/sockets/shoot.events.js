import { SocketEvents, SocketLimits, ErrorCodes, ShootGame } from '../helpers/constants.js';
import { shootGameService } from '../services/shoot.service.js';
import { setPlayerInGame, clearPlayerInGame, cancelInvitesForGameRoom } from '../services/friend.service.js';
import { sendSocketError } from './events.js';
import { takeToken } from './rateLimiter.js';
import { logger } from '../helpers/logger.js';

const { GameStatus, EndReason, Config } = ShootGame;

// Forfeit timers for players who dropped mid-game: key `${gameId}:${userId}`
const forfeitTimers = new Map();

// Turn auto-fire timeout timers: key `${gameId}`
const turnTimeoutTimers = new Map();

// Pending rematch requests: key `${gameId}` -> { requesterUserId, requestedAt }
const pendingRematches = new Map();

// Rounds where shoot:game:started has already been emitted: key `${gameId}:${round}`
const startedRounds = new Set();

const gameChannel = (gameId) => `shoot:${gameId}`;

// Clients connect on "/" or "/v1", and opponents may be on different namespaces.
const namespacesOf = (io) => [io.of('/'), io.of('/v1')];

export function broadcastShoot(io, gameId, event, payload, exceptSocketId) {
  if (!io) return;
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
  const timer = forfeitTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    forfeitTimers.delete(key);
  }
}

function cancelTurnTimeout(gameId) {
  const timer = turnTimeoutTimers.get(gameId);
  if (timer) {
    clearTimeout(timer);
    turnTimeoutTimers.delete(gameId);
  }
}

function announceGameOver(io, gameId, winner, winnerUserId, isDraw, reason, scores) {
  broadcastShoot(io, gameId, SocketEvents.SHOOT_GAME_OVER, {
    status: GameStatus.FINISHED,
    winner,
    winner_user_id: winnerUserId,
    is_draw: isDraw,
    reason: reason || EndReason.SCORE,
    scores,
  });
  if (reason && reason !== EndReason.SCORE && winnerUserId) clearPlayerInGame(io, winnerUserId);
}

function announceLeave(io, result, userId, exceptSocketId) {
  clearPlayerInGame(io, userId);
  broadcastShoot(
    io,
    result.game.id,
    SocketEvents.SHOOT_PLAYER_LEFT,
    { user_id: userId },
    exceptSocketId
  );

  if (result.abandoned) {
    broadcastShoot(io, result.game.id, SocketEvents.SHOOT_GAME_OVER, {
      status: GameStatus.ABANDONED,
      winner: result.winner,
      winner_user_id: result.winnerUserId,
      is_draw: false,
      reason: result.game.end_reason,
      scores: result.game.scores,
    });
  }
}

function armForfeit(io, gameId, userId) {
  const key = `${gameId}:${userId}`;
  if (forfeitTimers.has(key)) return;

  const timer = setTimeout(async () => {
    forfeitTimers.delete(key);
    cancelTurnTimeout(gameId);
    pendingRematches.delete(gameId);
    try {
      const result = await shootGameService.leaveGame({
        gameId,
        userId,
        reason: EndReason.OPPONENT_DISCONNECTED,
      });
      if (result.abandoned && result.game.host_id === userId) {
        cancelInvitesForGameRoom(io, { game: 'shoot', roomCode: result.game.code, reason: ErrorCodes.HOST_LEFT });
      }
      announceLeave(io, result, userId);
    } catch (err) {
      if (!err.statusCode) logger.error(`Failed to forfeit Shoot game ${gameId}:`, err);
    }
  }, SocketLimits.SHOOT_FORFEIT_TIMEOUT_MS);
  timer.unref();

  forfeitTimers.set(key, timer);
}

function armTurnTimeout(io, gameId, nextTurn) {
  cancelTurnTimeout(gameId);
  if (!nextTurn || !nextTurn.deadline_at) return;

  const delayMs = Math.max(0, Number(nextTurn.deadline_at) - Date.now());
  const expectedShotNumber = nextTurn.shot_number;
  const turnColor = nextTurn.color;

  const timer = setTimeout(async () => {
    turnTimeoutTimers.delete(gameId);
    try {
      const { game, players } = await shootGameService.getGame(gameId);
      if (game.status !== GameStatus.PLAYING) return;
      if (game.current_turn !== turnColor) return;
      if (Number(game.shot_number) + 1 !== expectedShotNumber) return;

      const player = players.find((p) => p.color === turnColor);
      if (!player) return;

      const result = await shootGameService.fireShot({
        gameId,
        userId: player.user_id,
        shotNumber: expectedShotNumber,
        elapsedMs: Config.turn_timeout_ms,
        auto: true,
      });

      // Broadcast auto-shot result to both players
      broadcastShoot(io, gameId, SocketEvents.SHOOT_FIRED, result.shotResult);

      if (result.isGameOver) {
        announceGameOver(
          io,
          gameId,
          result.winner,
          result.winnerUserId,
          result.isDraw,
          result.reason,
          result.game.scores
        );
      } else if (result.shotResult.next_turn) {
        armTurnTimeout(io, gameId, result.shotResult.next_turn);
      }
    } catch (err) {
      if (!err.statusCode) logger.error(`Error in turn timeout for Shoot game ${gameId}:`, err);
    }
  }, delayMs);
  timer.unref();

  turnTimeoutTimers.set(gameId, timer);
}

export function registerShootEvents(socket, io) {
  const { userId } = socket.data;

  /** Runs a handler with rate limiting and uniform error reporting. */
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
          sendSocketError(
            socket,
            event,
            err.code ?? failureCode ?? err.reason,
            err.message,
            ack,
            { reason: err.reason }
          );
          return;
        }
        logger.error(`Unexpected error in ${event} handler:`, err);
        sendSocketError(socket, event, ErrorCodes.SAVE_FAILED, 'Something went wrong', ack);
      }
    });
  };

  const requireJoinedGame = (payloadGameId) => {
    const gameId = payloadGameId || socket.data.shootGameId;
    if (!gameId) {
      const error = new Error('Join a game first');
      error.statusCode = 409;
      error.reason = ErrorCodes.NOT_IN_GAME;
      error.code = 'NOT_IN_GAME';
      throw error;
    }
    return gameId;
  };

  // shoot:time - Clock synchronization ping
  on(SocketEvents.SHOOT_TIME, null, async (_payload, ack) => {
    if (typeof ack === 'function') {
      ack({ ok: true, server_time: Date.now() });
    }
  });

  // shoot:game:join
  on(SocketEvents.SHOOT_GAME_JOIN, ErrorCodes.NOT_IN_GAME, async ({ game_id: gameId }, ack) => {
    const { game, players, color } = await shootGameService.getSeat({ gameId, userId });

    if (socket.data.shootGameId && socket.data.shootGameId !== gameId) {
      socket.leave(gameChannel(socket.data.shootGameId));
    }
    socket.join(gameChannel(gameId));
    socket.data.shootGameId = gameId;
    cancelForfeit(gameId, userId);

    if (typeof ack === 'function') {
      ack({ ok: true, game, players, your_color: color });
    }

    broadcastShoot(
      io,
      gameId,
      SocketEvents.SHOOT_PLAYER_JOINED,
      { user_id: userId, game, players },
      socket.id
    );

    // If both players have joined and game is playing, inform both with shoot:game:started (once per round)
    if (game.status === GameStatus.PLAYING) {
      const opponent = players.find((p) => p.user_id !== userId);
      if (opponent) {
        const opponentOnline = await isUserConnected(io, gameId, opponent.user_id);
        if (opponentOnline) {
          const roundKey = `${gameId}:${game.round}`;
          if (!startedRounds.has(roundKey)) {
            startedRounds.add(roundKey);
            // Synchronize turn.started_at = now + 1000 for the first start of this round
            const startData = await shootGameService.markRoundStarted({
              gameId,
              delayMs: Config.start_delay_ms,
            });
            const activeGame = startData ? startData.game : game;
            const activePlayers = startData ? startData.players : players;

            broadcastShoot(io, gameId, SocketEvents.SHOOT_GAME_STARTED, {
              game: activeGame,
              players: activePlayers,
            });

            cancelInvitesForGameRoom(io, { game: 'shoot', roomCode: game.code });
            setPlayerInGame(io, userId, 'shoot').catch(() => {});
            setPlayerInGame(io, opponent.user_id, 'shoot').catch(() => {});

            if (activeGame.turn) {
              armTurnTimeout(io, gameId, activeGame.turn);
            }
          }
        } else {
          armForfeit(io, gameId, opponent.user_id);
        }
      }
    }
  });

  // shoot:fire
  on(SocketEvents.SHOOT_FIRE, ErrorCodes.SHOT_FAILED, async (payload, ack) => {
    const gameId = requireJoinedGame(payload.game_id);
    const { shot_number: shotNumber, elapsed_ms: elapsedMs, client_x: clientX, client_y: clientY } = payload;

    const result = await shootGameService.fireShot({
      gameId,
      userId,
      shotNumber,
      elapsedMs,
      clientX,
      clientY,
      auto: false,
    });

    cancelTurnTimeout(gameId);

    if (typeof ack === 'function') {
      ack({ ok: true, ...result.shotResult });
    }

    // Broadcast shot result to opponent & other devices of the shooter
    broadcastShoot(io, gameId, SocketEvents.SHOOT_FIRED, result.shotResult, socket.id);

    // If game ended on this shot, broadcast game over event
    if (result.isGameOver) {
      announceGameOver(
        io,
        gameId,
        result.winner,
        result.winnerUserId,
        result.isDraw,
        result.reason,
        result.game.scores
      );
    } else if (result.shotResult.next_turn) {
      armTurnTimeout(io, gameId, result.shotResult.next_turn);
    }
  });

  // shoot:rematch:request
  on(SocketEvents.SHOOT_REMATCH_REQUEST, ErrorCodes.REMATCH_FAILED, async (payload, ack) => {
    const gameId = requireJoinedGame(payload.game_id);
    const { opponentUserId } = await shootGameService.requestRematch({ gameId, userId });

    const existing = pendingRematches.get(gameId);
    if (existing) {
      if (existing.requesterUserId === userId) {
        // Duplicate request from the same user: acknowledge, but do not re-broadcast
        if (typeof ack === 'function') ack({ ok: true });
        return;
      }

      // Both players have requested a rematch! Treat as mutual consent -> trigger restart
      pendingRematches.delete(gameId);
      const result = await shootGameService.respondRematch({
        gameId,
        userId,
        accept: true,
      });

      const roundKey = `${gameId}:${result.game.round}`;
      startedRounds.add(roundKey);

      if (typeof ack === 'function') {
        ack({ ok: true, game: result.game, players: result.players });
      }

      broadcastShoot(io, gameId, SocketEvents.SHOOT_GAME_RESTARTED, {
        game: result.game,
        players: result.players,
      });

      if (result.game.turn) {
        armTurnTimeout(io, gameId, result.game.turn);
      }
      return;
    }

    // Record pending rematch request
    pendingRematches.set(gameId, {
      requesterUserId: userId,
      requestedAt: Date.now(),
    });

    if (typeof ack === 'function') {
      ack({ ok: true });
    }

    broadcastShoot(
      io,
      gameId,
      SocketEvents.SHOOT_REMATCH_REQUESTED,
      { user_id: userId },
      socket.id
    );
  });

  // shoot:rematch:respond
  on(SocketEvents.SHOOT_REMATCH_RESPOND, ErrorCodes.REMATCH_FAILED, async (payload, ack) => {
    const gameId = requireJoinedGame(payload.game_id);
    const { accept } = payload;

    const pending = pendingRematches.get(gameId);
    if (!pending) {
      const error = new Error('No rematch request pending');
      error.statusCode = 409;
      error.code = ErrorCodes.REMATCH_FAILED;
      error.reason = ErrorCodes.NO_REMATCH_REQUEST;
      throw error;
    }

    if (pending.requesterUserId === userId) {
      const error = new Error('Cannot respond to your own rematch request');
      error.statusCode = 409;
      error.code = ErrorCodes.REMATCH_FAILED;
      error.reason = ErrorCodes.CANNOT_ACCEPT_OWN_REMATCH;
      throw error;
    }

    // Clear pending request once responded to
    pendingRematches.delete(gameId);

    const result = await shootGameService.respondRematch({
      gameId,
      userId,
      accept: Boolean(accept),
    });

    if (!result.accepted) {
      if (typeof ack === 'function') ack({ ok: true, accepted: false });
      broadcastShoot(
        io,
        gameId,
        SocketEvents.SHOOT_REMATCH_DECLINED,
        { user_id: userId },
        socket.id
      );
      return;
    }

    const roundKey = `${gameId}:${result.game.round}`;
    startedRounds.add(roundKey);

    if (typeof ack === 'function') {
      ack({ ok: true, game: result.game, players: result.players });
    }

    // Broadcast to BOTH players (no exceptSocketId)
    broadcastShoot(io, gameId, SocketEvents.SHOOT_GAME_RESTARTED, {
      game: result.game,
      players: result.players,
    });

    if (result.game.turn) {
      armTurnTimeout(io, gameId, result.game.turn);
    }
  });

  // shoot:game:leave
  on(SocketEvents.SHOOT_GAME_LEAVE, null, async (payload, ack) => {
    const gameId = requireJoinedGame(payload.game_id);
    cancelForfeit(gameId, userId);
    cancelTurnTimeout(gameId);
    pendingRematches.delete(gameId);

    const result = await shootGameService.leaveGame({ gameId, userId });
    if (result.abandoned && result.game.host_id === userId) {
      cancelInvitesForGameRoom(io, { game: 'shoot', roomCode: result.game.code, reason: ErrorCodes.HOST_LEFT });
    }

    socket.leave(gameChannel(gameId));
    socket.data.shootGameId = null;

    if (typeof ack === 'function') {
      ack({ ok: true, game_abandoned: result.abandoned });
    }

    announceLeave(io, result, userId);
  });

  // socket disconnect
  socket.on('disconnect', async () => {
    const gameId = socket.data.shootGameId;
    if (!gameId) return;

    try {
      if (await isUserConnected(io, gameId, userId, socket.id)) return;

      broadcastShoot(io, gameId, SocketEvents.SHOOT_PLAYER_DISCONNECTED, {
        user_id: userId,
        timeout_ms: SocketLimits.SHOOT_FORFEIT_TIMEOUT_MS,
      });

      const { game } = await shootGameService.getGame(gameId);
      if (game.status === GameStatus.PLAYING) {
        armForfeit(io, gameId, userId);
      }
    } catch (err) {
      if (!err.statusCode) logger.error('Error handling Shoot game disconnect:', err);
    }
  });
}

