import {
  SocketEvents,
  SocketLimits,
  ErrorCodes,
} from '../helpers/constants.js';
import {
  handleSocketConnect,
  handleSocketDisconnect,
  createGameInvite,
  respondToGameInvite,
  cancelGameInvite,
} from '../services/friend.service.js';
import { sendSocketError } from './events.js';
import { takeToken } from './rateLimiter.js';
import { logger } from '../helpers/logger.js';

export function registerFriendEvents(socket, io) {
  const { userId } = socket.data;

  // Initialize socket presence and join personal room
  if (userId) {
    handleSocketConnect(io, socket, userId).catch((err) => {
      logger.error(`Error in handleSocketConnect for ${userId}:`, err);
    });
  }

  // Handle disconnect
  socket.on('disconnect', () => {
    if (userId) {
      handleSocketDisconnect(io, socket, userId);
    }
  });

  const on = (event, failureCode, handler) => {
    socket.on(event, async (payload, ack) => {
      if (
        socket.data.actionRate &&
        !takeToken(socket.data.actionRate, SocketLimits.RATE_PER_SEC, SocketLimits.BURST)
      ) {
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
            err.code || failureCode || ErrorCodes.INVITE_FAILED,
            err.message,
            ack,
            { code: err.code }
          );
          return;
        }
        logger.error(`Unexpected error in ${event} handler:`, err);
        sendSocketError(socket, event, ErrorCodes.SAVE_FAILED, 'Something went wrong', ack);
      }
    });
  };

  // invite:send
  on(SocketEvents.INVITE_SEND, ErrorCodes.INVITE_FAILED, async (payload, ack) => {
    const toUserId = payload?.to_user_id || payload?.toUserId || payload?.to_userId;
    const game = payload?.game || payload?.game_type || payload?.gameType;
    const roomCode = payload?.room_code || payload?.roomCode || payload?.code || payload?.room_id || payload?.roomId;

    if (!toUserId || !game || !roomCode) {
      sendSocketError(
        socket,
        SocketEvents.INVITE_SEND,
        ErrorCodes.INVITE_FAILED,
        'Missing required invite fields (to_user_id, game, room_code)',
        ack
      );
      return;
    }

    const result = await createGameInvite(io, {
      hostUserId: userId,
      toUserId: String(toUserId).trim().toLowerCase(),
      game,
      roomCode,
    });

    if (typeof ack === 'function') {
      ack({ ok: true, invite_id: result.invite_id, expires_at: result.expires_at });
    }
  });

  // invite:respond
  on(SocketEvents.INVITE_RESPOND, ErrorCodes.INVITE_ENDED, async (payload, ack) => {
    const { invite_id: inviteId, accept } = payload;

    if (!inviteId) {
      sendSocketError(
        socket,
        SocketEvents.INVITE_RESPOND,
        ErrorCodes.INVITE_ENDED,
        'invite_id is required',
        ack
      );
      return;
    }

    const result = await respondToGameInvite(io, {
      inviteId,
      friendUserId: userId,
      accept: Boolean(accept),
    });

    if (typeof ack === 'function') {
      ack({ ok: true, ...result });
    }
  });

  // invite:cancel
  on(SocketEvents.INVITE_CANCEL, ErrorCodes.INVITE_FAILED, async (payload, ack) => {
    const { invite_id: inviteId } = payload;

    if (!inviteId) {
      if (typeof ack === 'function') ack({ ok: true });
      return;
    }

    const result = cancelGameInvite(io, {
      inviteId,
      hostUserId: userId,
    });

    if (typeof ack === 'function') {
      ack({ ok: true, ...result });
    }
  });
}

