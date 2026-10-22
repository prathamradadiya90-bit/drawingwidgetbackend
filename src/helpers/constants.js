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
};
