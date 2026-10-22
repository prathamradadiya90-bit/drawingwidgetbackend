import crypto from 'node:crypto';
import { SocketEvents, SocketLimits, DeviceTypes } from '../helpers/constants.js';
import { roomService } from '../services/room.service.js';
import { strokeService } from '../services/stroke.service.js';
import { chatService } from '../services/chat.service.js';
import { takeToken } from './rateLimiter.js';
import { logger } from '../helpers/logger.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(id) {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

function isValidStrokeAdd(p) {
  if (!p || typeof p !== 'object') return false;
  return (
    isValidUuid(p.id) &&
    (p.kind === 'line' || p.kind === 'fill') &&
    typeof p.step_index === 'number' &&
    Number.isInteger(p.step_index) &&
    typeof p.stroke_data === 'string' &&
    p.stroke_data.length > 0 &&
    p.stroke_data.length <= SocketLimits.MAX_STROKE_DATA_LEN
  );
}

function isValidStrokeErase(p) {
  if (!p || typeof p !== 'object') return false;
  return (
    Array.isArray(p.stroke_ids) &&
    p.stroke_ids.every(isValidUuid) &&
    typeof p.step_index === 'number' &&
    Number.isInteger(p.step_index)
  );
}

function isValidAndroidStrokeAdd(p) {
  if (!p || typeof p !== 'object') return false;
  const validEventTypes = ['STROKE', 'UNDO', 'REDO', 'CLEAR', 'NEXT_STEP', 'COMPLETE_LESSON'];
  return (
    (p.id === undefined || isValidUuid(p.id)) &&
    typeof p.event_type === 'string' &&
    validEventTypes.includes(p.event_type) &&
    (typeof p.stroke_data === 'object' || typeof p.stroke_data === 'string' || p.stroke_data === undefined)
  );
}

function isValidChatAdd(p) {
  if (!p || typeof p !== 'object') return false;
  return (
    (p.id === undefined || isValidUuid(p.id)) &&
    typeof p.message === 'string' &&
    p.message.trim().length > 0 &&
    p.message.length <= SocketLimits.MAX_CHAT_LENGTH
  );
}

/**
 * Register all real-time drawing and room events on a connected socket
 */
export function registerSocketEvents(socket, io) {
  if (!socket.data || !socket.data.userId) return;

  const { userId, deviceType } = socket.data;
  logger.info(`Socket connected: ${socket.id} (user: ${userId.slice(0, 8)}, platform: ${deviceType})`);

  // --- ROOM JOIN ---
  socket.on(SocketEvents.ROOM_JOIN, async (payload, ack) => {
    const roomId = payload?.room_id;
    if (!isValidUuid(roomId)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Valid room_id is required' });
      return;
    }

    try {
      const member = await roomService.getRoomMemberRaw(roomId, userId);
      if (!member) {
        if (typeof ack === 'function') ack({ ok: false, error: 'You are not a member of this room' });
        return;
      }

      const { room } = await roomService.getRoom(roomId);
      if (room.device_type !== deviceType) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Cannot join room from a different platform' });
        return;
      }

      // If already in another room, leave previous room cleanly
      if (socket.data.roomId && socket.data.roomId !== roomId) {
        socket.to(socket.data.roomId).emit(SocketEvents.PRESENCE_LEAVE, { user_id: userId });
        await socket.leave(socket.data.roomId);
      }

      await socket.join(roomId);
      socket.data.roomId = roomId;

      // Broadcast presence join to peers in this room
      socket.to(roomId).emit(SocketEvents.PRESENCE_JOIN, {
        user_id: userId,
        name: member.name,
      });

      if (typeof ack === 'function') ack({ ok: true });

      // Backfill existing strokes & chat to new participant
      try {
        if (deviceType === DeviceTypes.ANDROID) {
          const strokes = await strokeService.listAndroidStrokes(roomId);
          socket.emit(SocketEvents.ANDROID_STROKE_BACKFILL, { strokes });
        } else {
          const strokes = await strokeService.listStrokes(roomId);
          socket.emit(SocketEvents.STROKE_BACKFILL, { strokes });
        }

        const chats = await chatService.listChats(roomId);
        socket.emit(SocketEvents.CHAT_BACKFILL, { chats });
      } catch (backfillErr) {
        logger.error(`Error backfilling room ${roomId}:`, backfillErr);
      }
    } catch (err) {
      logger.error(`Error in room:join handler:`, err);
      if (typeof ack === 'function') ack({ ok: false, error: err.message || 'Room not found' });
    }
  });

  // --- ROOM LEAVE ---
  socket.on(SocketEvents.ROOM_LEAVE, async () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    socket.to(roomId).emit(SocketEvents.PRESENCE_LEAVE, { user_id: userId });
    await socket.leave(roomId);
    socket.data.roomId = undefined;
  });

  // --- LIVE DRAWING STREAM (Zero-latency relay) ---
  socket.on(SocketEvents.STROKE_MOVE, (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId || !isValidStrokeAdd(payload)) return;

    // Direct relay with user_id attached — no DB latency for smooth drawing
    socket.to(roomId).emit(SocketEvents.STROKE_MOVE, {
      ...payload,
      user_id: userId,
    });
  });

  // --- FINALIZED STROKE ADD ---
  socket.on(SocketEvents.STROKE_ADD, (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId || !isValidStrokeAdd(payload)) return;
    if (!takeToken(socket.data.rate)) return;

    const stroke = {
      id: payload.id,
      roomId,
      userId,
      stepIndex: payload.step_index,
      kind: payload.kind,
      strokeData: payload.stroke_data,
      createdAt: new Date().toISOString(),
    };

    // Broadcast immediately to peers
    socket.to(roomId).emit(SocketEvents.STROKE_ADD, {
      id: stroke.id,
      room_id: roomId,
      user_id: userId,
      step_index: stroke.stepIndex,
      kind: stroke.kind,
      stroke_data: stroke.strokeData,
      created_at: stroke.createdAt,
    });

    // Asynchronously persist to database
    strokeService.saveStroke(stroke).catch((err) => {
      logger.error(`Failed to persist stroke ${stroke.id}:`, err);
    });
  });

  // --- STROKE ERASE ---
  socket.on(SocketEvents.STROKE_ERASE, (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId || !isValidStrokeErase(payload)) return;
    if (!takeToken(socket.data.rate)) return;

    socket.to(roomId).emit(SocketEvents.STROKE_ERASE, {
      room_id: roomId,
      user_id: userId,
      stroke_ids: payload.stroke_ids,
      step_index: payload.step_index,
    });

    strokeService.eraseStrokes(roomId, userId, payload.stroke_ids).catch((err) => {
      logger.error(`Failed to erase strokes in ${roomId}:`, err);
    });
  });

  // --- ANDROID LIVE DRAWING RELAY ---
  socket.on(SocketEvents.ANDROID_STROKE_MOVE, (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    socket.to(roomId).emit(SocketEvents.ANDROID_STROKE_MOVE, {
      ...payload,
      user_id: userId,
    });
  });

  // --- ANDROID STROKE ADD ---
  socket.on(SocketEvents.ANDROID_STROKE_ADD, (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId || !isValidAndroidStrokeAdd(payload)) return;
    if (!takeToken(socket.data.rate)) return;

    const strokeId = payload.id || crypto.randomUUID();
    const stroke = {
      id: strokeId,
      roomId,
      userId,
      eventType: payload.event_type,
      strokeData: payload.stroke_data || {},
      createdAt: new Date().toISOString(),
    };

    socket.to(roomId).emit(SocketEvents.ANDROID_STROKE_ADD, {
      id: stroke.id,
      room_id: roomId,
      user_id: userId,
      event_type: stroke.eventType,
      stroke_data: stroke.strokeData,
      created_at: stroke.createdAt,
    });

    strokeService.saveAndroidStroke(stroke).catch((err) => {
      logger.error(`Failed to persist Android stroke for room ${roomId}:`, err);
    });
  });

  // --- LIVE CHAT ---
  socket.on(SocketEvents.CHAT_ADD, async (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId || !isValidChatAdd(payload)) return;
    if (!takeToken(socket.data.rate)) return;

    const chatId = payload.id || crypto.randomUUID();
    const member = await roomService.getRoomMemberRaw(roomId, userId);

    const chat = {
      id: chatId,
      roomId,
      userId,
      message: payload.message.trim(),
      createdAt: new Date().toISOString(),
    };

    socket.to(roomId).emit(SocketEvents.CHAT_ADD, {
      id: chat.id,
      room_id: roomId,
      user_id: userId,
      name: member?.name || 'Unknown',
      message: chat.message,
      created_at: chat.createdAt,
    });

    chatService.saveChat(chat).catch((err) => {
      logger.error(`Failed to persist chat message ${chat.id}:`, err);
    });
  });

  // --- DISCONNECT ---
  socket.on('disconnect', (reason) => {
    if (socket.data.roomId) {
      socket.to(socket.data.roomId).emit(SocketEvents.PRESENCE_LEAVE, { user_id: userId });
    }
    logger.info(`Socket disconnected: ${socket.id} (${reason})`);
  });
}
