import { SocketEvents, SocketLimits, ErrorCodes, KnifeGame } from '../helpers/constants.js';
import { knifeGameService } from '../services/knife.service.js';
import { setPlayerInGame, clearPlayerInGame, cancelInvitesForGameRoom } from '../services/friend.service.js';
import { sendSocketError } from './events.js';
import { takeToken } from './rateLimiter.js';
import { logger } from '../helpers/logger.js';

const { GameStatus, EndReason } = KnifeGame;

// Forfeit timers for players who dropped mid-game: key `${gameId}:${userId}`
const forfeitTimers = new Map();

// Pending rematch requests: key `${gameId}` -> { requesterUserId, requestedAt }
const pendingRematches = new Map();

// Rounds where knife:game:started has already been emitted: key `${gameId}:${round}`
const startedRounds = new Set();

const gameChannel = (gameId) => `knife:${gameId}`;

// Clients connect on "/" or "/v1", and opponents may be on different namespaces.
const namespacesOf = (io) => [io.of('/'), io.of('/v1')];

export function broadcastKnife(io, gameId, event, payload, exceptSocketId) {
  if (!io) return;
  for (const nsp of namespacesOf(io)) {
    const target = nsp.to(gameChannel(gameId));
    (exceptSocketId ? target.except(exceptSocketId) : target).emit(event, payload);
  }
}

const broadcast = broadcastKnife;

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

function announceGameOver(io, gameId, winner, winnerUserId, isDraw, reason, scores, lives, level) {
  if (winnerUserId) clearPlayerInGame(io, winnerUserId);
  broadcast(io, gameId, SocketEvents.KNIFE_GAME_OVER, {
    status: GameStatus.FINISHED,
    winner,
    winner_user_id: winnerUserId,
    is_draw: isDraw,
    reason: reason || 'SCORE',
    scores,
    lives,
    level,
  });
}

function announceLeave(io, result, userId, exceptSocketId) {
  clearPlayerInGame(io, userId);
  broadcast(
    io,
    result.game.id,
    SocketEvents.KNIFE_PLAYER_LEFT,
    { user_id: userId },
    exceptSocketId
  );

  if (result.abandoned) {
    broadcast(io, result.game.id, SocketEvents.KNIFE_GAME_OVER, {
      status: GameStatus.ABANDONED,
      winner: result.winner,
      winner_user_id: result.winnerUserId,
      is_draw: false,
      reason: result.game.end_reason,
      scores: result.game.scores,
      lives: result.game.lives,
      level: result.game.level,
    });
  }
}

function armForfeit(io, gameId, userId) {
  const key = `${gameId}:${userId}`;
  if (forfeitTimers.has(key)) return;

  const timer = setTimeout(async () => {
    forfeitTimers.delete(key);
    pendingRematches.delete(gameId);
    try {
      const result = await knifeGameService.leaveGame({
        gameId,
        userId,
        reason: EndReason.OPPONENT_DISCONNECTED,
      });
      announceLeave(io, result, userId);
    } catch (err) {
      if (!err.statusCode) logger.error(`Failed to forfeit Knife game ${gameId}:`, err);
    }
  }, SocketLimits.KNIFE_FORFEIT_TIMEOUT_MS);
  timer.unref();

  forfeitTimers.set(key, timer);
}

export function registerKnifeEvents(socket, io) {
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
    const gameId = payloadGameId || socket.data.knifeGameId;
    if (!gameId) {
      const error = new Error('Join a game first');
      error.statusCode = 409;
      error.reason = ErrorCodes.NOT_IN_GAME;
      error.code = 'NOT_IN_GAME';
      throw error;
    }
    return gameId;
  };

  // knife:time - Clock synchronization ping
  on(SocketEvents.KNIFE_TIME, null, async (_payload, ack) => {
    if (typeof ack === 'function') {
      ack({ ok: true, server_time: Date.now() });
    }
  });

  // knife:game:join
  on(SocketEvents.KNIFE_GAME_JOIN, ErrorCodes.NOT_IN_GAME, async ({ game_id: gameId }, ack) => {
    const { game, players, color } = await knifeGameService.getSeat({ gameId, userId });

    if (socket.data.knifeGameId && socket.data.knifeGameId !== gameId) {
      socket.leave(gameChannel(socket.data.knifeGameId));
    }
    socket.join(gameChannel(gameId));
    socket.data.knifeGameId = gameId;
    cancelForfeit(gameId, userId);

    if (typeof ack === 'function') {
      ack({ ok: true, game, players, your_color: color });
    }

    broadcast(
      io,
      gameId,
      SocketEvents.KNIFE_PLAYER_JOINED,
      { game, players },
      socket.id
    );

    // If both players have joined and game is playing, inform both with knife:game:started (only once per round)
    if (game.status === GameStatus.PLAYING) {
      const opponent = players.find((p) => p.user_id !== userId);
      if (opponent) {
        const opponentOnline = await isUserConnected(io, gameId, opponent.user_id);
        if (opponentOnline) {
          const roundKey = `${gameId}:${game.round}`;
          if (!startedRounds.has(roundKey)) {
            startedRounds.add(roundKey);
            cancelInvitesForGameRoom(io, { game: 'knife', roomCode: game.code });
            setPlayerInGame(io, userId, 'knife');
            setPlayerInGame(io, opponent.user_id, 'knife');
            broadcast(io, gameId, SocketEvents.KNIFE_GAME_STARTED, { game, players });
          }
        } else {
          armForfeit(io, gameId, opponent.user_id);
        }
      }
    }
  });

  // knife:throw
  on(SocketEvents.KNIFE_THROW, ErrorCodes.THROW_FAILED, async (payload, ack) => {
    const gameId = requireJoinedGame(payload.game_id);
    const { throw_number: throwNumber, level, angle } = payload;

    const result = await knifeGameService.throwKnife({
      gameId,
      userId,
      throwNumber,
      level,
      angle,
    });

    if (typeof ack === 'function') {
      ack({ ok: true, ...result.throwResult });
    }

    // Broadcast throw result to opponent & other devices
    broadcast(io, gameId, SocketEvents.KNIFE_THROWN, result.throwResult, socket.id);

    // If game ended on this throw, broadcast game over event
    if (result.isGameOver) {
      announceGameOver(
        io,
        gameId,
        result.winner,
        result.winnerUserId,
        result.isDraw,
        result.reason || result.endReason || 'SCORE',
        result.game.scores,
        result.game.lives,
        result.game.level
      );
    }
  });

  // knife:rematch:request
  on(SocketEvents.KNIFE_REMATCH_REQUEST, ErrorCodes.REMATCH_FAILED, async (payload, ack) => {
    const gameId = requireJoinedGame(payload.game_id);
    const { opponentUserId } = await knifeGameService.requestRematch({ gameId, userId });

    const existing = pendingRematches.get(gameId);
    if (existing) {
      if (existing.requesterUserId === userId) {
        // Duplicate request from the same user: acknowledge, but do not re-broadcast
        if (typeof ack === 'function') ack({ ok: true });
        return;
      }

      // Both players have requested a rematch! Treat as mutual consent -> trigger restart
      pendingRematches.delete(gameId);
      const result = await knifeGameService.respondRematch({
        gameId,
        userId,
        accept: true,
      });

      const roundKey = `${gameId}:${result.game.round}`;
      startedRounds.add(roundKey);

      if (typeof ack === 'function') {
        ack({ ok: true, game: result.game, players: result.players });
      }

      broadcast(
        io,
        gameId,
        SocketEvents.KNIFE_GAME_RESTARTED,
        { game: result.game, players: result.players }
      );
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

    broadcast(
      io,
      gameId,
      SocketEvents.KNIFE_REMATCH_REQUESTED,
      { user_id: userId },
      socket.id
    );
  });

  // knife:rematch:respond
  on(SocketEvents.KNIFE_REMATCH_RESPOND, ErrorCodes.REMATCH_FAILED, async (payload, ack) => {
    const gameId = requireJoinedGame(payload.game_id);
    const { accept } = payload;

    const pending = pendingRematches.get(gameId);
    if (!pending) {
      const error = new Error('No rematch request pending');
      error.statusCode = 409;
      error.code = ErrorCodes.REMATCH_FAILED;
      error.reason = 'NO_REMATCH_REQUEST';
      throw error;
    }

    if (pending.requesterUserId === userId) {
      const error = new Error('Cannot respond to your own rematch request');
      error.statusCode = 409;
      error.code = ErrorCodes.REMATCH_FAILED;
      error.reason = 'CANNOT_ACCEPT_OWN_REMATCH';
      throw error;
    }

    // Clear pending request once responded to
    pendingRematches.delete(gameId);

    const result = await knifeGameService.respondRematch({
      gameId,
      userId,
      accept: Boolean(accept),
    });

    if (!result.accepted) {
      if (typeof ack === 'function') ack({ ok: true, accepted: false });
      broadcast(
        io,
        gameId,
        SocketEvents.KNIFE_REMATCH_DECLINED,
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
    broadcast(
      io,
      gameId,
      SocketEvents.KNIFE_GAME_RESTARTED,
      { game: result.game, players: result.players }
    );
  });

  // knife:game:leave
  on(SocketEvents.KNIFE_GAME_LEAVE, null, async (payload, ack) => {
    const gameId = requireJoinedGame(payload.game_id);
    cancelForfeit(gameId, userId);
    pendingRematches.delete(gameId);
    const result = await knifeGameService.leaveGame({ gameId, userId });

    socket.leave(gameChannel(gameId));
    socket.data.knifeGameId = null;

    if (typeof ack === 'function') {
      ack({ ok: true, game_abandoned: result.abandoned });
    }

    announceLeave(io, result, userId);
  });

  // socket disconnect
  socket.on('disconnect', async () => {
    const gameId = socket.data.knifeGameId;
    if (!gameId) return;

    try {
      if (await isUserConnected(io, gameId, userId, socket.id)) return;

      broadcast(io, gameId, SocketEvents.KNIFE_PLAYER_DISCONNECTED, {
        user_id: userId,
        timeout_ms: SocketLimits.KNIFE_FORFEIT_TIMEOUT_MS,
      });

      const { game } = await knifeGameService.getGame(gameId);
      if (game.status === GameStatus.PLAYING) {
        armForfeit(io, gameId, userId);
      }
    } catch (err) {
      if (!err.statusCode) logger.error('Error handling Knife game disconnect:', err);
    }
  });
}

