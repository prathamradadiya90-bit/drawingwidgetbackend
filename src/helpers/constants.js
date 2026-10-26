export const SocketEvents = {
  // Client -> Server
  ROOM_JOIN: 'room:join',
  ROOM_LEAVE: 'room:leave',
  STROKE_ADD: 'stroke:add',
  STROKE_MOVE: 'stroke:move',
  STROKE_ERASE: 'stroke:erase',
  ANDROID_STROKE_ADD: 'android:stroke:add',
  ANDROID_STROKE_MOVE: 'android:stroke:move',
  CHAT_ADD: 'chat:add',

  // Server -> Client
  PRESENCE_JOIN: 'presence:join',
  PRESENCE_LEAVE: 'presence:leave',
  STROKE_BACKFILL: 'stroke:backfill',
  ANDROID_STROKE_BACKFILL: 'android:stroke:backfill',
  CHAT_BACKFILL: 'chat:backfill',
  STROKE_SAVED: 'stroke:saved',
  STROKE_ERROR: 'stroke:error',
  ANDROID_STROKE_SAVED: 'android:stroke:saved',
  ROOM_CLOSED: 'room:closed',
  ERROR: 'error',
};

export const DeviceTypes = {
  IOS: 'ios',
  ANDROID: 'android',
};

export const RoomLimits = {
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 4,
  CODE_LENGTH: 6,
  CODE_ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
};

export const SocketLimits = {
  RATE_PER_SEC: 50,
  BURST: 200,
  MAX_STROKE_DATA_LEN: 100_000_000, // 100MB
  MAX_CHAT_LENGTH: 10_000,
  DISCONNECT_GRACE_MS: 5_000, // 5s wait before broadcasting presence:leave
  APP_KILL_TIMEOUT_MS: 60_000, // 60s timeout after disconnect to free player slot
};

export const ErrorCodes = {
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  INVALID_ROOM_ID: 'INVALID_ROOM_ID',
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_CLOSED: 'ROOM_CLOSED',
  ROOM_FULL: 'ROOM_FULL',
  PLATFORM_MISMATCH: 'PLATFORM_MISMATCH',
  UNAUTHORIZED_ERASE: 'UNAUTHORIZED_ERASE',
  INVALID_STROKE_ID: 'INVALID_STROKE_ID',
  INVALID_STROKE_KIND: 'INVALID_STROKE_KIND',
  INVALID_STROKE_DATA: 'INVALID_STROKE_DATA',
  INVALID_STEP_INDEX: 'INVALID_STEP_INDEX',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  SAVE_FAILED: 'SAVE_FAILED',
};
