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
  TTT_GAME_JOIN: 'ttt:game:join',
  TTT_GAME_LEAVE: 'ttt:game:leave',
  TTT_MOVE: 'ttt:move',
  TTT_RESTART: 'ttt:restart',

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
  ROOM_MEMBERS: 'room:members',
  TTT_PLAYER_JOINED: 'ttt:player:joined',
  TTT_PLAYER_LEFT: 'ttt:player:left',
  TTT_PLAYER_DISCONNECTED: 'ttt:player:disconnected',
  TTT_MOVE_MADE: 'ttt:move:made',
  TTT_GAME_OVER: 'ttt:game:over',
  TTT_GAME_RESTARTED: 'ttt:game:restarted',
  ERROR: 'app:error',
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

export const TicTacToe = {
  BOARD_SIZE: 9,
  EMPTY_CELL: '-',
  Symbols: { X: 'X', O: 'O' },
  GameStatus: {
    WAITING: 'waiting',
    PLAYING: 'playing',
    FINISHED: 'finished',
    ABANDONED: 'abandoned',
  },
  EndReason: {
    WIN: 'WIN',
    DRAW: 'DRAW',
    OPPONENT_LEFT: 'OPPONENT_LEFT',
    OPPONENT_DISCONNECTED: 'OPPONENT_DISCONNECTED',
  },
  WIN_LINES: [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ],
};

export const SocketLimits = {
  RATE_PER_SEC: 120, // 120 updates/sec for persistent stroke actions
  BURST: 600, // Generous burst allowance for rapid multi-touch / complex stroke additions
  MOVE_RATE_PER_SEC: 180, // 180 updates/sec for live drawing streams (Apple Pencil / 120Hz displays)
  MOVE_BURST: 600,
  PING_TIMEOUT_MS: 20_000, // 20s ping timeout to rapidly detect and handle dropped connections
  PING_INTERVAL_MS: 20_000, // 20s ping interval to prevent Render proxy (60s) and iOS URLSession idle timeout
  MAX_STROKE_DATA_LEN: 100_000_000, // 100MB
  MAX_CHAT_LENGTH: 10_000,
  APP_KILL_TIMEOUT_MS: 60_000, // 60s timeout after disconnect to free player slot
  TTT_FORFEIT_TIMEOUT_MS: 60_000, // 60s for a dropped Tic Tac Toe player to reconnect before forfeiting
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
  GAME_NOT_FOUND: 'GAME_NOT_FOUND',
  NOT_IN_GAME: 'NOT_IN_GAME',
  MOVE_FAILED: 'MOVE_FAILED',
  RESTART_FAILED: 'RESTART_FAILED',
};
