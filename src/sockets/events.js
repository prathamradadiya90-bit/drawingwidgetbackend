import crypto from 'node:crypto';
import { SocketEvents, SocketLimits, DeviceTypes, ErrorCodes } from '../helpers/constants.js';
import { roomService } from '../services/room.service.js';
import { strokeService } from '../services/stroke.service.js';
import { chatService } from '../services/chat.service.js';
import { pool } from '../config/db.js';
import { takeToken } from './rateLimiter.js';
import { logger } from '../helpers/logger.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(id) {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

// In-memory disconnect timers: key `${roomId}:${userId}` -> { graceTimer, killTimer }
const disconnectTimers = new Map();

// In-memory recent stroke cache per room for deduplication (Item 7)
const roomRecentStrokes = new Map();
const MAX_RECENT_STROKES_PER_ROOM = 2000;

function markStrokeSeen(roomId, strokeId) {
  if (!roomRecentStrokes.has(roomId)) {
    roomRecentStrokes.set(roomId, new Set());
  }
  const set = roomRecentStrokes.get(roomId);
  set.add(strokeId);
  if (set.size > MAX_RECENT_STROKES_PER_ROOM) {
    const oldest = set.values().next().value;
    set.delete(oldest);
  }
}

function isStrokeSeen(roomId, strokeId) {
  return roomRecentStrokes.get(roomId)?.has(strokeId) || false;
}

/**
 * Send structured error back to socket client via ack callback and error events
 */
function sendSocketError(socket, eventName, code, message, ack, extra = {}) {
  const errorPayload = {
    ok: false,
    error: message,
    code,
    event: eventName,
    ...extra,
  };

  // Call client acknowledgement callback if provided
  if (typeof ack === 'function') {
    try {
      ack(errorPayload);
    } catch (_) {}
  }

  // Throttle error event emission to prevent client socket buffer overflow (max 1 error per 400ms)
  const now = Date.now();
  if (!socket.data._lastErrorTime || now - socket.data._lastErrorTime > 400) {
    socket.data._lastErrorTime = now;
    socket.emit(SocketEvents.ERROR, errorPayload);

    // Emit specialized stroke:error event for drawing failures
    if (
      eventName === SocketEvents.STROKE_ADD ||
      eventName === SocketEvents.STROKE_MOVE ||
      eventName === SocketEvents.STROKE_ERASE
    ) {
      socket.emit(SocketEvents.STROKE_ERROR, errorPayload);
    }
  }
}

const VALID_KINDS = ['line', 'fill', 'shape', 'emoji'];

/**
 * Detailed validation for iOS PKDrawing stroke add / move, shape, and emoji
 */
function validateStrokeAdd(p) {
  if (!p || typeof p !== 'object') {
    return { valid: false, code: ErrorCodes.INVALID_STROKE_ID, message: 'Payload must be a JSON object' };
  }
  if (!isValidUuid(p.id)) {
    return { valid: false, code: ErrorCodes.INVALID_STROKE_ID, message: 'Stroke id must be a valid UUID' };
  }
  const kind = p.kind || 'line';
  if (!VALID_KINDS.includes(kind)) {
    return { valid: false, code: ErrorCodes.INVALID_STROKE_KIND, message: 'Stroke kind must be "line", "fill", "shape", or "emoji"' };
  }

  const hasStringData = typeof p.stroke_data === 'string' && p.stroke_data.length > 0;
  const hasObjectData = typeof p.stroke_data === 'object' && p.stroke_data !== null;
  const hasShapeOrEmojiFields =
    p.kind === 'shape' ||
    p.kind === 'emoji' ||
    p.coordinates !== undefined ||
    p.emoji_id !== undefined ||
    p.shape_type !== undefined;

  if (!hasStringData && !hasObjectData && !hasShapeOrEmojiFields) {
    return { valid: false, code: ErrorCodes.INVALID_STROKE_DATA, message: 'Drawing data must be provided as a non-empty string or object' };
  }

  if (hasStringData && p.stroke_data.length > SocketLimits.MAX_STROKE_DATA_LEN) {
    return { valid: false, code: ErrorCodes.PAYLOAD_TOO_LARGE, message: 'Drawing payload exceeds maximum allowed length (100MB)' };
  }

  if (
    p.step_index !== undefined &&
    p.step_index !== null &&
    (!Number.isInteger(p.step_index) || typeof p.step_index !== 'number')
  ) {
    return { valid: false, code: ErrorCodes.INVALID_STEP_INDEX, message: 'step_index must be an integer if provided' };
  }
  return { valid: true };
}

/**
 * Normalize shape and emoji fields from either top-level payload or inside stroke_data
 */
function normalizeStrokePayload(p) {
  let strokeData = p.stroke_data;
  const extraFields = {};

  if (p.kind === 'shape' || p.kind === 'emoji') {
    const rawObj = typeof p.stroke_data === 'object' && p.stroke_data !== null ? p.stroke_data : {};

    // Coordinates: extract from coordinates object or top-level x, y
    let coordinates = p.coordinates || rawObj.coordinates || null;
    if (!coordinates && (p.x !== undefined || rawObj.x !== undefined || p.y !== undefined || rawObj.y !== undefined)) {
      coordinates = {
        x: p.x !== undefined ? p.x : (rawObj.x !== undefined ? rawObj.x : 0),
        y: p.y !== undefined ? p.y : (rawObj.y !== undefined ? rawObj.y : 0),
      };
    }

    // Size: extract from size object or top-level width, height
    let size = p.size || rawObj.size || null;
    if (!size && (p.width !== undefined || rawObj.width !== undefined || p.height !== undefined || rawObj.height !== undefined)) {
      size = {
        width: p.width !== undefined ? p.width : (rawObj.width !== undefined ? rawObj.width : 0),
        height: p.height !== undefined ? p.height : (rawObj.height !== undefined ? rawObj.height : 0),
      };
    }

    // Angle of rotation: angle or rotation (default: 0)
    const angle = p.angle !== undefined
      ? p.angle
      : (rawObj.angle !== undefined
        ? rawObj.angle
        : (p.rotation !== undefined
          ? p.rotation
          : (rawObj.rotation !== undefined ? rawObj.rotation : 0)));

    if (p.kind === 'shape') {
      const shapeType = p.shape_type || p.shapeType || rawObj.shape_type || rawObj.shapeType || null;
      const strokeId =
        p.stroke_id ||
        p.strokeId ||
        p.stoke_id ||
        p.stroke_color ||
        p.strokeColor ||
        rawObj.stroke_id ||
        rawObj.strokeId ||
        rawObj.stroke_color ||
        rawObj.strokeColor ||
        null;
      const fillId =
        p.fill_id ||
        p.fillId ||
        p.fill_color ||
        p.fillColor ||
        rawObj.fill_id ||
        rawObj.fillId ||
        rawObj.fill_color ||
        rawObj.fillColor ||
        null;
      const strokeWidth = p.stroke_width !== undefined
        ? p.stroke_width
        : (p.strokeWidth !== undefined
          ? p.strokeWidth
          : (rawObj.stroke_width !== undefined
            ? rawObj.stroke_width
            : (rawObj.strokeWidth !== undefined ? rawObj.strokeWidth : null)));

      extraFields.shape_type = shapeType;
      extraFields.stroke_id = strokeId;
      extraFields.fill_id = fillId;
      extraFields.stroke_color = strokeId;
      extraFields.fill_color = fillId;
      extraFields.stroke_width = strokeWidth;
      extraFields.coordinates = coordinates;
      extraFields.size = size;
      extraFields.angle = angle;
    } else if (p.kind === 'emoji') {
      const emojiId = p.emoji_id || p.emojiId || rawObj.emoji_id || rawObj.emojiId || null;

      extraFields.emoji_id = emojiId;
      extraFields.coordinates = coordinates;
      extraFields.size = size;
      extraFields.angle = angle;
    }

    if (typeof strokeData !== 'string' || strokeData === '' || strokeData === '{}') {
      strokeData = {
        ...rawObj,
        ...extraFields,
      };
    }
  }

  return {
    strokeData: strokeData ?? '',
    extraFields,
  };
}

/**
 * Detailed validation for iOS stroke erase
 */
function validateStrokeErase(p) {
  if (!p || typeof p !== 'object') {
    return { valid: false, code: ErrorCodes.INVALID_STROKE_ID, message: 'Payload must be a JSON object' };
  }
  if (!Array.isArray(p.stroke_ids) || p.stroke_ids.length === 0) {
    return { valid: false, code: ErrorCodes.INVALID_STROKE_ID, message: 'stroke_ids must be a non-empty array of UUIDs' };
  }
  if (!p.stroke_ids.every(isValidUuid)) {
    return { valid: false, code: ErrorCodes.INVALID_STROKE_ID, message: 'All items in stroke_ids must be valid UUIDs' };
  }
  if (
    p.step_index !== undefined &&
    p.step_index !== null &&
    (!Number.isInteger(p.step_index) || typeof p.step_index !== 'number')
  ) {
    return { valid: false, code: ErrorCodes.INVALID_STEP_INDEX, message: 'step_index must be an integer if provided' };
  }
  return { valid: true };
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

  // Handle low-level transport/socket errors gracefully
  socket.on('error', (err) => {
    logger.error(`Socket error on ${socket.id} (user: ${userId.slice(0, 8)}):`, err);
  });

  if (socket.conn) {
    socket.conn.on('error', (err) => {
      logger.error(`Transport error on socket ${socket.id} (user: ${userId.slice(0, 8)}):`, err);
    });
    socket.conn.on('close', (reason, description) => {
      logger.info(`Transport closed for socket ${socket.id} (user: ${userId.slice(0, 8)}): reason="${reason}", description="${description || 'none'}"`);
    });
  }

  // --- ROOM JOIN ---
  socket.on(SocketEvents.ROOM_JOIN, async (payload, ack) => {
    const roomId = payload?.room_id;
    if (!isValidUuid(roomId)) {
      sendSocketError(socket, SocketEvents.ROOM_JOIN, ErrorCodes.INVALID_ROOM_ID, 'Valid room_id UUID is required', ack);
      return;
    }

    try {
      // Item 5: Ensure user actually joined through REST before letting them into room events
      const member = await roomService.getRoomMemberRaw(roomId, userId);
      if (!member) {
        sendSocketError(
          socket,
          SocketEvents.ROOM_JOIN,
          ErrorCodes.NOT_A_MEMBER,
          'You are not an active member of this room. Please join via room code first.',
          ack
        );
        return;
      }

      const { room } = await roomService.getRoom(roomId);
      if (!room) {
        sendSocketError(socket, SocketEvents.ROOM_JOIN, ErrorCodes.ROOM_NOT_FOUND, 'Room not found or has expired', ack);
        return;
      }

      if (room.device_type !== deviceType) {
        sendSocketError(
          socket,
          SocketEvents.ROOM_JOIN,
          ErrorCodes.PLATFORM_MISMATCH,
          `Cannot join room created for a different platform (${room.device_type})`,
          ack
        );
        return;
      }

      // Item 9: If user had a pending disconnect timer, cancel it (user reconnected cleanly)
      const disconnectKey = `${roomId}:${userId}`;
      const pendingDisconnect = disconnectTimers.get(disconnectKey);
      let wasTemporarilyDisconnected = false;
      if (pendingDisconnect) {
        if (pendingDisconnect.killTimer) clearTimeout(pendingDisconnect.killTimer);
        disconnectTimers.delete(disconnectKey);
        wasTemporarilyDisconnected = true;
      }

      // If already in another room, leave previous room cleanly
      if (socket.data.roomId && socket.data.roomId !== roomId) {
        socket.to(socket.data.roomId).emit(SocketEvents.PRESENCE_LEAVE, { user_id: userId });
        await socket.leave(socket.data.roomId);
      }

      // Check if user provided an updated name or profile_image upon socket connection / room:join
      const incomingName = payload?.name || socket.data.name;
      const incomingProfileImage =
        payload?.profile_image ||
        payload?.profileImage ||
        payload?.avatar_url ||
        payload?.avatarUrl ||
        payload?.avatar ||
        socket.data.profileImage;

      let memberName = member.name;
      let memberProfileImage = member.profile_image || null;

      if (
        (incomingName && incomingName !== member.name) ||
        (incomingProfileImage && incomingProfileImage !== member.profile_image)
      ) {
        await pool.query(
          `UPDATE room_members
           SET name = COALESCE($3, name), profile_image = COALESCE($4, profile_image)
           WHERE room_id = $1 AND user_id = $2`,
          [roomId, userId, incomingName || null, incomingProfileImage || null]
        );
        if (incomingName) memberName = incomingName;
        if (incomingProfileImage) memberProfileImage = incomingProfileImage;
      }

      await socket.join(roomId);
      socket.data.roomId = roomId;

      // Broadcast presence join to peers in this room with name and profile image
      socket.to(roomId).emit(SocketEvents.PRESENCE_JOIN, {
        user_id: userId,
        name: memberName,
        profile_image: memberProfileImage,
        avatar_url: memberProfileImage,
        slot_index: member.slot_index,
        reconnected: wasTemporarilyDisconnected,
      });

      // Retrieve full room member list so the joining client immediately sees all peer profiles
      const { members: roomMembers } = await roomService.getRoom(roomId);
      const formattedMembers = (roomMembers || []).map((m) => ({
        user_id: m.user_id,
        name: m.name,
        profile_image: m.profile_image || null,
        avatar_url: m.profile_image || null,
        slot_index: m.slot_index,
      }));

      if (typeof ack === 'function') {
        ack({
          ok: true,
          room_id: roomId,
          host_id: room.host_id,
          user_id: userId,
          slot_index: member.slot_index,
          name: memberName,
          profile_image: memberProfileImage,
          avatar_url: memberProfileImage,
          reconnected: wasTemporarilyDisconnected,
          members: formattedMembers,
        });
      }

      // Also emit room:members event so client can restore player list anytime
      socket.emit(SocketEvents.ROOM_MEMBERS, {
        room_id: roomId,
        host_id: room.host_id,
        members: formattedMembers,
      });

      // Backfill existing strokes & chat
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
      sendSocketError(socket, SocketEvents.ROOM_JOIN, ErrorCodes.ROOM_NOT_FOUND, err.message || 'Room not found', ack);
    }
  });

  // --- ROOM LEAVE ---
  socket.on(SocketEvents.ROOM_LEAVE, async (payload, ack) => {
    const roomId = socket.data.roomId;
    if (!roomId) {
      if (typeof ack === 'function') ack({ ok: true, message: 'Not currently in a room' });
      return;
    }

    // Cancel any pending disconnect timers
    const disconnectKey = `${roomId}:${userId}`;
    const pending = disconnectTimers.get(disconnectKey);
    if (pending) {
      if (pending.killTimer) clearTimeout(pending.killTimer);
      disconnectTimers.delete(disconnectKey);
    }

    try {
      // Item 10 & 11: Free player slot and handle host departure
      const leaveResult = await roomService.leaveRoom({ roomId, userId });

      if (leaveResult.room_closed) {
        // Item 11: Host left -> broadcast room closed to all peers
        socket.to(roomId).emit(SocketEvents.ROOM_CLOSED, {
          reason: 'HOST_LEFT',
          message: 'The host has left the room. Room session ended.',
        });
      } else {
        // Non-host left -> announce presence leave immediately
        socket.to(roomId).emit(SocketEvents.PRESENCE_LEAVE, { user_id: userId });
      }

      await socket.leave(roomId);
      socket.data.roomId = undefined;

      if (typeof ack === 'function') ack({ ok: true, ...leaveResult });
    } catch (err) {
      logger.error(`Error in room:leave handler:`, err);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // --- LIVE DRAWING STREAM (Zero-latency relay) ---
  socket.on(SocketEvents.STROKE_MOVE, (payload, ack) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) {
        sendSocketError(socket, SocketEvents.STROKE_MOVE, ErrorCodes.NOT_IN_ROOM, 'Socket is not in an active room. Call room:join first.', ack);
        return;
      }

      const validation = validateStrokeAdd(payload);
      if (!validation.valid) {
        // Do not emit disruptive stroke:error / app:error on high-frequency ephemeral preview frames
        if (typeof ack === 'function') ack({ ok: false, error: validation.message, code: validation.code });
        return;
      }

      // High-frequency move rate limiting (separate token bucket from stroke:add)
      // When points arrive faster than relay rate, drop intermediate preview frames gracefully
      // without emitting fatal error events that disconnect the socket
      const moveBucket = socket.data.moveRate || socket.data.rate;
      if (!takeToken(moveBucket, SocketLimits.MOVE_RATE_PER_SEC, SocketLimits.MOVE_BURST)) {
        if (typeof ack === 'function') ack({ ok: true, id: payload.id, throttled: true });
        return;
      }

      // Direct relay with user_id attached — 0ms DB delay for smooth continuous drawing
      const { strokeData: moveStrokeData, extraFields: moveExtraFields } = normalizeStrokePayload(payload);
      socket.to(roomId).emit(SocketEvents.STROKE_MOVE, {
        ...payload,
        ...moveExtraFields,
        stroke_data: moveStrokeData,
        step_index: payload.step_index !== undefined ? payload.step_index : null,
        user_id: userId,
      });

      if (typeof ack === 'function') ack({ ok: true, id: payload.id });
    } catch (err) {
      logger.error('Unexpected error in stroke:move handler:', err);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // --- FINALIZED STROKE ADD ---
  socket.on(SocketEvents.STROKE_ADD, async (payload, ack) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) {
        sendSocketError(socket, SocketEvents.STROKE_ADD, ErrorCodes.NOT_IN_ROOM, 'Socket is not in an active room. Call room:join first.', ack);
        return;
      }

      // Item 2: Send error back for bad stroke events
      const validation = validateStrokeAdd(payload);
      if (!validation.valid) {
        sendSocketError(socket, SocketEvents.STROKE_ADD, validation.code, validation.message, ack, { stroke_id: payload?.id });
        return;
      }

      // Item 8: Rate limit behavior for database persistence (uses dedicated actionRate bucket)
      const actionBucket = socket.data.actionRate || socket.data.rate;
      if (!takeToken(actionBucket, SocketLimits.RATE_PER_SEC, SocketLimits.BURST)) {
        sendSocketError(socket, SocketEvents.STROKE_ADD, ErrorCodes.RATE_LIMIT_EXCEEDED, 'Stroke rate limit exceeded. Please slow down.', ack, { stroke_id: payload.id });
        return;
      }

      // Item 7: Accept the same stroke twice safely (idempotent resend upon reconnect)
      if (isStrokeSeen(roomId, payload.id)) {
        if (typeof ack === 'function') {
          ack({ ok: true, id: payload.id, saved: true, duplicate: true });
        }
        socket.emit(SocketEvents.STROKE_SAVED, { id: payload.id, ok: true, duplicate: true });
        return;
      }

      markStrokeSeen(roomId, payload.id);

      const { strokeData, extraFields } = normalizeStrokePayload(payload);
      const stroke = {
        id: payload.id,
        roomId,
        userId,
        stepIndex: payload.step_index !== undefined ? payload.step_index : null,
        kind: payload.kind,
        strokeData,
        createdAt: new Date().toISOString(),
      };

      // Broadcast immediately to peers for 0-latency live rendering
      socket.to(roomId).emit(SocketEvents.STROKE_ADD, {
        id: stroke.id,
        room_id: roomId,
        user_id: userId,
        step_index: stroke.stepIndex,
        kind: stroke.kind,
        stroke_data: stroke.strokeData,
        ...extraFields,
        created_at: stroke.createdAt,
      });

      // Item 6: Persist stroke and confirm saved to sender
      try {
        await strokeService.saveStroke(stroke);
        if (typeof ack === 'function') {
          ack({ ok: true, id: stroke.id, saved: true });
        }
        socket.emit(SocketEvents.STROKE_SAVED, { id: stroke.id, ok: true });
      } catch (err) {
        logger.error(`Failed to persist stroke ${stroke.id}:`, err);
        // Remove from seen cache so the client can retry saving
        roomRecentStrokes.get(roomId)?.delete(stroke.id);
        sendSocketError(socket, SocketEvents.STROKE_ADD, ErrorCodes.SAVE_FAILED, 'Failed to persist stroke to database', ack, { id: stroke.id });
      }
    } catch (err) {
      logger.error('Unexpected error in stroke:add handler:', err);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // --- STROKE ERASE ---
  socket.on(SocketEvents.STROKE_ERASE, async (payload, ack) => {
    const roomId = socket.data.roomId;
    if (!roomId) {
      sendSocketError(socket, SocketEvents.STROKE_ERASE, ErrorCodes.NOT_IN_ROOM, 'Socket is not in an active room. Call room:join first.', ack);
      return;
    }

    const validation = validateStrokeErase(payload);
    if (!validation.valid) {
      sendSocketError(socket, SocketEvents.STROKE_ERASE, validation.code, validation.message, ack);
      return;
    }

    const actionBucket = socket.data.actionRate || socket.data.rate;
    if (!takeToken(actionBucket, SocketLimits.RATE_PER_SEC, SocketLimits.BURST)) {
      sendSocketError(socket, SocketEvents.STROKE_ERASE, ErrorCodes.RATE_LIMIT_EXCEEDED, 'Rate limit exceeded. Please slow down.', ack);
      return;
    }

    try {
      // Item 1: Only the owner can erase their stroke
      const erasedIds = await strokeService.eraseStrokes(roomId, userId, payload.stroke_ids);

      if (erasedIds.length === 0) {
        sendSocketError(
          socket,
          SocketEvents.STROKE_ERASE,
          ErrorCodes.UNAUTHORIZED_ERASE,
          'Cannot erase strokes: none of the specified stroke IDs belong to you or they do not exist',
          ack,
          { stroke_ids: payload.stroke_ids }
        );
        return;
      }

      // Broadcast ONLY the erased IDs that were legitimately owned and deleted by this user
      socket.to(roomId).emit(SocketEvents.STROKE_ERASE, {
        room_id: roomId,
        user_id: userId,
        stroke_ids: erasedIds,
        step_index: payload.step_index !== undefined ? payload.step_index : null,
      });

      if (typeof ack === 'function') {
        ack({ ok: true, erased_ids: erasedIds });
      }
    } catch (err) {
      logger.error(`Failed to erase strokes in ${roomId}:`, err);
      sendSocketError(socket, SocketEvents.STROKE_ERASE, ErrorCodes.SAVE_FAILED, 'Database error while erasing strokes', ack);
    }
  });

  // --- ANDROID LIVE DRAWING RELAY ---
  socket.on(SocketEvents.ANDROID_STROKE_MOVE, (payload, ack) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) {
        sendSocketError(socket, SocketEvents.ANDROID_STROKE_MOVE, ErrorCodes.NOT_IN_ROOM, 'Socket is not in an active room', ack);
        return;
      }

      const moveBucket = socket.data.moveRate || socket.data.rate;
      if (!takeToken(moveBucket, SocketLimits.MOVE_RATE_PER_SEC, SocketLimits.MOVE_BURST)) {
        if (typeof ack === 'function') ack({ ok: true, throttled: true });
        return;
      }

      socket.to(roomId).emit(SocketEvents.ANDROID_STROKE_MOVE, {
        ...payload,
        user_id: userId,
      });

      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      logger.error('Unexpected error in android:stroke:move handler:', err);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // --- ANDROID STROKE ADD ---
  socket.on(SocketEvents.ANDROID_STROKE_ADD, async (payload, ack) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) {
        sendSocketError(socket, SocketEvents.ANDROID_STROKE_ADD, ErrorCodes.NOT_IN_ROOM, 'Socket is not in an active room', ack);
        return;
      }

      if (!isValidAndroidStrokeAdd(payload)) {
        sendSocketError(socket, SocketEvents.ANDROID_STROKE_ADD, ErrorCodes.INVALID_STROKE_DATA, 'Invalid Android stroke payload', ack);
        return;
      }

      const actionBucket = socket.data.actionRate || socket.data.rate;
      if (!takeToken(actionBucket, SocketLimits.RATE_PER_SEC, SocketLimits.BURST)) {
        sendSocketError(socket, SocketEvents.ANDROID_STROKE_ADD, ErrorCodes.RATE_LIMIT_EXCEEDED, 'Rate limit exceeded. Please slow down.', ack);
        return;
      }

      const strokeId = payload.id || crypto.randomUUID();

      // Deduplication check
      if (isStrokeSeen(roomId, strokeId)) {
        if (typeof ack === 'function') ack({ ok: true, id: strokeId, saved: true, duplicate: true });
        socket.emit(SocketEvents.ANDROID_STROKE_SAVED, { id: strokeId, ok: true, duplicate: true });
        return;
      }

      markStrokeSeen(roomId, strokeId);

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

      try {
        await strokeService.saveAndroidStroke(stroke);
        if (typeof ack === 'function') ack({ ok: true, id: stroke.id, saved: true });
        socket.emit(SocketEvents.ANDROID_STROKE_SAVED, { id: stroke.id, ok: true });
      } catch (err) {
        logger.error(`Failed to persist Android stroke for room ${roomId}:`, err);
        roomRecentStrokes.get(roomId)?.delete(stroke.id);
        sendSocketError(socket, SocketEvents.ANDROID_STROKE_ADD, ErrorCodes.SAVE_FAILED, 'Failed to persist Android stroke', ack, { id: stroke.id });
      }
    } catch (err) {
      logger.error('Unexpected error in android:stroke:add handler:', err);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // --- LIVE CHAT ---
  socket.on(SocketEvents.CHAT_ADD, async (payload, ack) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) {
        sendSocketError(socket, SocketEvents.CHAT_ADD, ErrorCodes.NOT_IN_ROOM, 'Socket is not in an active room', ack);
        return;
      }

      if (!isValidChatAdd(payload)) {
        sendSocketError(socket, SocketEvents.CHAT_ADD, ErrorCodes.INVALID_STROKE_DATA, 'Message must be between 1 and 10,000 characters', ack);
        return;
      }

      const actionBucket = socket.data.actionRate || socket.data.rate;
      if (!takeToken(actionBucket, SocketLimits.RATE_PER_SEC, SocketLimits.BURST)) {
        sendSocketError(socket, SocketEvents.CHAT_ADD, ErrorCodes.RATE_LIMIT_EXCEEDED, 'Chat rate limit exceeded. Please slow down.', ack);
        return;
      }

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
      profile_image: member?.profile_image || null,
      avatar_url: member?.profile_image || null,
      message: chat.message,
      created_at: chat.createdAt,
    });

    try {
      await chatService.saveChat(chat);
      if (typeof ack === 'function') ack({ ok: true, id: chat.id });
    } catch (err) {
      logger.error(`Failed to persist chat message ${chat.id}:`, err);
      sendSocketError(socket, SocketEvents.CHAT_ADD, ErrorCodes.SAVE_FAILED, 'Failed to persist chat message', ack, { id: chat.id });
    }
  } catch (err) {
    logger.error('Unexpected error in chat:add handler:', err);
    if (typeof ack === 'function') ack({ ok: false, error: err.message });
  }
  });

  // --- DISCONNECT ---
  socket.on('disconnect', async (reason) => {
    const roomId = socket.data.roomId;
    logger.info(`Socket disconnected: ${socket.id} (user: ${userId.slice(0, 8)}, reason: ${reason})`);
    if (!roomId) return;

    // Check if user still has other open sockets in the same room (e.g. multiple tabs / rapid reconnect)
    try {
      const roomSockets = await socket.nsp.in(roomId).fetchSockets();
      const hasOtherSocket = roomSockets.some((s) => s.id !== socket.id && s.data.userId === userId);
      if (hasOtherSocket) {
        return;
      }
    } catch (err) {
      logger.error('Error checking room sockets on disconnect:', err);
    }

    const disconnectKey = `${roomId}:${userId}`;

    // Cancel existing pending killTimer if any
    const existing = disconnectTimers.get(disconnectKey);
    if (existing?.killTimer) {
      clearTimeout(existing.killTimer);
    }

    // Immediately broadcast presence:leave so peers are notified that the member dropped connection
    try {
      socket.to(roomId).emit(SocketEvents.PRESENCE_LEAVE, {
        user_id: userId,
        reason: reason || 'disconnected',
      });
      logger.info(`Broadcasted presence:leave for user ${userId.slice(0, 8)} in room ${roomId} (reason: ${reason})`);
    } catch (err) {
      logger.error('Error emitting presence:leave on disconnect:', err);
    }

    // Item 10: 60-second app kill timeout to free player slot in database if leave call never arrives
    const killTimer = setTimeout(async () => {
      disconnectTimers.delete(disconnectKey);
      try {
        const leaveResult = await roomService.leaveRoom({ roomId, userId });
        logger.info(`App-kill timeout reached: freed slot for user ${userId.slice(0, 8)} in room ${roomId}`);

        // Item 11: If host disconnected and never returned, close the room session
        if (leaveResult.room_closed) {
          socket.to(roomId).emit(SocketEvents.ROOM_CLOSED, {
            reason: 'HOST_DISCONNECTED',
            message: 'The host has disconnected. Room session ended.',
          });
        }
      } catch (err) {
        // Ignored if user already left or room deleted
      }
    }, SocketLimits.APP_KILL_TIMEOUT_MS);

    disconnectTimers.set(disconnectKey, { killTimer });
  });
}
