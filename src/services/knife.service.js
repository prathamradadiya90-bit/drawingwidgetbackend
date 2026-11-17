import { pool, withTransaction } from '../config/db.js';
import { DeviceTypes, ErrorCodes, KnifeGame } from '../helpers/constants.js';
import { ServiceError, generateRoomCode, getDefaultUserName } from './room.service.js';

const { GameStatus, EndReason, Colors, Config } = KnifeGame;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Helper to throw consistent service errors with a machine-readable reason */
function gameError(reason, message, statusCode = 409, code = 'THROW_FAILED') {
  const error = new ServiceError(message, statusCode);
  error.reason = reason;
  error.code = code;
  return error;
}

export const otherColor = (color) => (color === Colors.RED ? Colors.BLUE : Colors.RED);

/**
 * Calculates the shortest angular distance (0° - 180°) between two angles on a circle.
 * d = |a - b| mod 360, gap = min(d, 360 - d)
 */
export function angleGap(a, b) {
  const d = Math.abs(Number(a) - Number(b)) % 360;
  return Math.min(d, 360 - d);
}

/**
 * Generates evenly spaced apples for a level starting at a random angle.
 * Count = min(2 + 2 * level, 20)
 */
export function generateApples(level, customStartAngle = null) {
  const count = KnifeGame.getAppleCount(level);
  const startAngle =
    customStartAngle !== null
      ? Number(customStartAngle)
      : Math.round(Math.random() * 3600) / 10;

  const apples = [];
  for (let i = 0; i < count; i++) {
    const rawAngle = (startAngle + (i * 360) / count) % 360;
    const angle = Math.round((((rawAngle % 360) + 360) % 360) * 10) / 10;
    apples.push({
      index: i,
      angle,
      cut: false,
      cut_by: null,
    });
  }
  return apples;
}

function parseJson(val, fallback) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

export function serializeGame(row) {
  return {
    id: row.id,
    code: row.code,
    host_id: row.host_id,
    status: row.status,
    round: row.round,
    level: row.level,
    level_started_at: Number(row.level_started_at || 0),
    server_time: Date.now(),
    current_turn: row.current_turn,
    throw_number: row.throw_number,
    scores: parseJson(row.scores, { red: 0, blue: 0 }),
    lives: parseJson(row.lives, { red: Config.LIVES, blue: Config.LIVES }),
    apples: parseJson(row.apples, []),
    stuck_knives: parseJson(row.stuck_knives, []),
    winner: row.winner,
    winner_user_id: row.winner_user_id,
    is_draw: Boolean(row.is_draw),
    end_reason: row.end_reason,
    config: parseJson(row.config, {
      lives: Config.LIVES,
      knife_touch_deg: Config.KNIFE_TOUCH_DEG,
      apple_touch_deg: Config.APPLE_TOUCH_DEG,
      level_pause_ms: Config.LEVEL_PAUSE_MS,
    }),
  };
}

export function serializePlayer(row) {
  return {
    user_id: row.user_id,
    color: row.color,
    name: row.name,
    profile_image: row.profile_image,
    left_at: row.left_at,
  };
}

async function listPlayers(db, gameId) {
  const { rows } = await db.query(
    'SELECT * FROM knife_players WHERE game_id = $1 ORDER BY joined_at, user_id',
    [gameId]
  );
  return rows.map(serializePlayer);
}

async function lockGame(client, gameId) {
  if (typeof gameId !== 'string' || !UUID_REGEX.test(gameId)) {
    throw gameError(ErrorCodes.GAME_NOT_FOUND, 'Game not found', 404, 'GAME_NOT_FOUND');
  }
  const { rows } = await client.query('SELECT * FROM knife_games WHERE id = $1 FOR UPDATE', [gameId]);
  if (!rows[0]) {
    throw gameError(ErrorCodes.GAME_NOT_FOUND, 'Game not found', 404, 'GAME_NOT_FOUND');
  }
  return rows[0];
}

async function requireActivePlayer(client, gameId, userId) {
  const { rows } = await client.query(
    'SELECT * FROM knife_players WHERE game_id = $1 AND user_id = $2 AND left_at IS NULL',
    [gameId, userId]
  );
  if (!rows[0]) {
    throw gameError(ErrorCodes.NOT_IN_GAME, 'You are not a player in this game', 403, 'NOT_IN_GAME');
  }
  return rows[0];
}

export const knifeGameService = {
  /** Create a Knife Game. Host plays red and waits for blue. */
  async createGame({ name, profileImage = null, hostId, deviceType = DeviceTypes.IOS }) {
    const normalizedHostId = String(hostId).trim().toLowerCase();

    return await withTransaction(async (client) => {
      let game = null;
      const initialApples = generateApples(1);

      for (let attempt = 0; attempt < 20 && !game; attempt++) {
        const { rows } = await client.query(
          `INSERT INTO knife_games (
             code, host_id, status, round, level, level_started_at,
             current_turn, throw_number, scores, lives, apples, stuck_knives
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (code) DO NOTHING
           RETURNING *`,
          [
            generateRoomCode(),
            normalizedHostId,
            GameStatus.WAITING,
            1,
            1,
            0,
            null,
            0,
            JSON.stringify({ red: 0, blue: 0 }),
            JSON.stringify({ red: Config.LIVES, blue: Config.LIVES }),
            JSON.stringify(initialApples),
            JSON.stringify([]),
          ]
        );
        game = rows[0];
      }

      if (!game) {
        throw new ServiceError('Could not allocate a unique game code. Please try again.', 500);
      }

      await client.query(
        `INSERT INTO knife_players (game_id, user_id, color, name, profile_image, device_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          game.id,
          normalizedHostId,
          Colors.RED,
          name || getDefaultUserName(normalizedHostId),
          profileImage,
          deviceType,
        ]
      );

      return {
        game: serializeGame(game),
        color: Colors.RED,
        players: await listPlayers(client, game.id),
      };
    });
  },

  /**
   * Join by code as blue. Starts the game. Calling again with the same userId returns
   * the existing seat safely without error.
   */
  async joinGame({ code, name, profileImage = null, userId, deviceType = DeviceTypes.IOS }) {
    if (!code || typeof code !== 'string') {
      throw new ServiceError('Game code is required', 422);
    }
    const normalizedCode = code.trim().toUpperCase();
    const normalizedUserId = String(userId).trim().toLowerCase();

    return await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM knife_games WHERE code = $1 FOR UPDATE', [
        normalizedCode,
      ]);
      let game = rows[0];
      if (!game) {
        throw new ServiceError(`No game found with code ${normalizedCode}`, 404);
      }

      const seatRes = await client.query(
        'SELECT * FROM knife_players WHERE game_id = $1 AND user_id = $2',
        [game.id, normalizedUserId]
      );
      const existing = seatRes.rows[0];

      if (existing?.left_at) {
        throw new ServiceError('You have already left this game', 409);
      }

      if (!existing) {
        if (game.status !== GameStatus.WAITING) {
          throw new ServiceError('This game is full or has already ended', 409);
        }

        await client.query(
          `INSERT INTO knife_players (game_id, user_id, color, name, profile_image, device_type)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            game.id,
            normalizedUserId,
            Colors.BLUE,
            name || getDefaultUserName(normalizedUserId),
            profileImage,
            deviceType,
          ]
        );

        // Start game: round 1 starts with red, level_started_at set in future by pause time
        const levelStartedAt = Date.now() + Config.LEVEL_PAUSE_MS;
        const started = await client.query(
          `UPDATE knife_games
           SET status = $2, current_turn = $3, level_started_at = $4, started_at = NOW(), updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [game.id, GameStatus.PLAYING, Colors.RED, levelStartedAt]
        );
        game = started.rows[0];
      }

      return {
        game: serializeGame(game),
        color: existing?.color ?? Colors.BLUE,
        players: await listPlayers(client, game.id),
      };
    });
  },

  async getGame(gameId) {
    if (typeof gameId !== 'string' || !UUID_REGEX.test(gameId)) {
      throw gameError(ErrorCodes.GAME_NOT_FOUND, 'Game not found', 404, 'GAME_NOT_FOUND');
    }
    const { rows } = await pool.query('SELECT * FROM knife_games WHERE id = $1', [gameId]);
    if (!rows[0]) {
      throw gameError(ErrorCodes.GAME_NOT_FOUND, 'Game not found', 404, 'GAME_NOT_FOUND');
    }
    return { game: serializeGame(rows[0]), players: await listPlayers(pool, gameId) };
  },

  async getGameByCode(code) {
    const normalizedCode = String(code || '').trim().toUpperCase();
    const { rows } = await pool.query('SELECT * FROM knife_games WHERE code = $1', [normalizedCode]);
    if (!rows[0]) {
      throw gameError(ErrorCodes.GAME_NOT_FOUND, `No game found with code ${normalizedCode}`, 404, 'GAME_NOT_FOUND');
    }
    return { game: serializeGame(rows[0]), players: await listPlayers(pool, rows[0].id) };
  },

  /** Returns caller's seat and game state for socket join. Rejects non-players and players who left. */
  async getSeat({ gameId, userId }) {
    const normalizedUserId = String(userId).trim().toLowerCase();
    const { game, players } = await this.getGame(gameId);
    const seatRes = await pool.query(
      'SELECT * FROM knife_players WHERE game_id = $1 AND user_id = $2 AND left_at IS NULL',
      [gameId, normalizedUserId]
    );
    const seat = seatRes.rows[0];
    if (!seat) {
      throw gameError(ErrorCodes.NOT_IN_GAME, 'You are not a player in this game', 403, 'NOT_IN_GAME');
    }
    return { game, players, color: seat.color };
  },

  /**
   * Evaluates a knife throw according to game rules.
   * Clank -> loses 1 heart, no knife stuck, no points.
   * Stick -> knife stuck, cuts apples within 14°, +1 pt per apple.
   * Level cleared -> all apples cut, level + 1, stuck knives cleared, new apples.
   * Game over -> either lives <= 0, higher score wins.
   */
  async throwKnife({ gameId, userId, throwNumber, level, angle }) {
    if (typeof angle !== 'number' || !Number.isFinite(angle) || angle < 0 || angle >= 360) {
      throw gameError(
        ErrorCodes.INVALID_ANGLE,
        'Angle must be a number between 0 and 360',
        422,
        'THROW_FAILED'
      );
    }
    if (!Number.isInteger(throwNumber) || throwNumber < 1) {
      throw gameError(ErrorCodes.STALE_THROW, 'Invalid throw_number', 422, 'THROW_FAILED');
    }

    const normalizedUserId = String(userId).trim().toLowerCase();

    return await withTransaction(async (client) => {
      const gameRow = await lockGame(client, gameId);
      const player = await requireActivePlayer(client, gameId, normalizedUserId);

      if (gameRow.status !== GameStatus.PLAYING) {
        throw gameError(ErrorCodes.GAME_NOT_ACTIVE, 'This game is not in progress', 409, 'THROW_FAILED');
      }

      if (level !== gameRow.level) {
        throw gameError(ErrorCodes.STALE_THROW, 'Level mismatch', 409, 'THROW_FAILED');
      }

      if (throwNumber !== gameRow.throw_number + 1) {
        throw gameError(ErrorCodes.STALE_THROW, 'Stale throw number', 409, 'THROW_FAILED');
      }

      if (gameRow.current_turn !== player.color) {
        throw gameError(ErrorCodes.NOT_YOUR_TURN, 'It is not your turn', 409, 'THROW_FAILED');
      }

      const now = Date.now();
      if (now < Number(gameRow.level_started_at || 0)) {
        throw gameError(ErrorCodes.LEVEL_STARTING, 'Level is still starting', 409, 'THROW_FAILED');
      }

      let stuckKnives = parseJson(gameRow.stuck_knives, []);
      let apples = parseJson(gameRow.apples, []);
      const scores = parseJson(gameRow.scores, { red: 0, blue: 0 });
      const lives = parseJson(gameRow.lives, { red: Config.LIVES, blue: Config.LIVES });
      const config = parseJson(gameRow.config, Config);

      // Step 1: Check Clank (within 13.5° of any stuck knife)
      const isClank = stuckKnives.some(
        (knife) => angleGap(angle, knife.angle) < config.knife_touch_deg
      );

      let result = 'stick';
      let applesCut = [];
      let points = 0;
      let levelCleared = false;
      let nextLevel = null;
      let nextLevelNum = gameRow.level;
      let nextLevelStartedAt = Number(gameRow.level_started_at);

      if (isClank) {
        result = 'clank';
        lives[player.color] = Math.max(0, lives[player.color] - 1);
        // Knife is not added to the log, apples_cut is [], points is 0
      } else {
        result = 'stick';
        stuckKnives.push({
          angle: Math.round(angle * 10) / 10,
          color: player.color,
        });

        // Step 2: Cut apples within 14°
        for (const apple of apples) {
          if (!apple.cut && angleGap(angle, apple.angle) < config.apple_touch_deg) {
            apple.cut = true;
            apple.cut_by = player.color;
            applesCut.push(apple.index);
          }
        }

        points = applesCut.length;
        scores[player.color] += points;

        // Step 3: Check Level Cleared (all apples cut)
        const allCut = apples.length > 0 && apples.every((a) => a.cut);
        if (allCut) {
          levelCleared = true;
          nextLevelNum = gameRow.level + 1;
          nextLevelStartedAt = now + config.level_pause_ms;
          const nextApples = generateApples(nextLevelNum);

          nextLevel = {
            level: nextLevelNum,
            level_started_at: nextLevelStartedAt,
            apples: nextApples,
          };

          // For saving in DB for next throw:
          stuckKnives = [];
          apples = nextApples;
        }
      }

      // Step 4: Game Over Check (hearts reach 0)
      const isGameOver = lives.red <= 0 || lives.blue <= 0;
      let status = gameRow.status;
      let winner = null;
      let winnerUserId = null;
      let isDraw = false;
      let endReason = null;
      let nextTurn = null;

      const players = await listPlayers(client, gameId);
      const redPlayer = players.find((p) => p.color === Colors.RED);
      const bluePlayer = players.find((p) => p.color === Colors.BLUE);

      if (isGameOver) {
        status = GameStatus.FINISHED;
        endReason = EndReason.SCORE;
        nextTurn = null;

        if (scores.red > scores.blue) {
          winner = Colors.RED;
          winnerUserId = redPlayer?.user_id ?? null;
          isDraw = false;
        } else if (scores.blue > scores.red) {
          winner = Colors.BLUE;
          winnerUserId = bluePlayer?.user_id ?? null;
          isDraw = false;
        } else {
          winner = null;
          winnerUserId = null;
          isDraw = true;
        }
      } else {
        nextTurn = otherColor(player.color);
      }

      // Update game row in database
      const updateRes = await client.query(
        `UPDATE knife_games
         SET status = $2,
             level = $3,
             level_started_at = $4,
             current_turn = $5,
             throw_number = $6,
             scores = $7,
             lives = $8,
             apples = $9,
             stuck_knives = $10,
             winner = $11,
             winner_user_id = $12,
             is_draw = $13,
             end_reason = $14,
             finished_at = CASE WHEN $15 THEN NOW() ELSE finished_at END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          gameId,
          status,
          nextLevelNum,
          nextLevelStartedAt,
          nextTurn,
          throwNumber,
          JSON.stringify(scores),
          JSON.stringify(lives),
          JSON.stringify(apples),
          JSON.stringify(stuckKnives),
          winner,
          winnerUserId,
          isDraw,
          endReason,
          isGameOver,
        ]
      );

      // Insert record into knife_throws history
      await client.query(
        `INSERT INTO knife_throws (
           game_id, round, throw_number, level, user_id, color,
           angle, result, apples_cut, points, scores, lives
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          gameId,
          gameRow.round,
          throwNumber,
          gameRow.level,
          normalizedUserId,
          player.color,
          angle,
          result,
          applesCut,
          points,
          JSON.stringify(scores),
          JSON.stringify(lives),
        ]
      );

      const updatedGame = serializeGame(updateRes.rows[0]);

      const throwResult = {
        game_id: gameId,
        user_id: normalizedUserId,
        color: player.color,
        throw_number: throwNumber,
        angle: angle,
        result: result,
        apples_cut: applesCut,
        points: points,
        scores: scores,
        lives: lives,
        next_turn: nextTurn,
        next_throw_number: throwNumber + 1,
        level_cleared: levelCleared,
        next_level: nextLevel,
        game_over: isGameOver,
        server_time: now,
      };

      return {
        throwResult,
        game: updatedGame,
        players,
        winner,
        winnerUserId,
        isDraw,
        reason: endReason,
        endReason,
        isGameOver,
      };
    });
  },

  /** Request a rematch after game finishes. Opponent must accept. */
  async requestRematch({ gameId, userId }) {
    const normalizedUserId = String(userId).trim().toLowerCase();

    return await withTransaction(async (client) => {
      const game = await lockGame(client, gameId);
      await requireActivePlayer(client, gameId, normalizedUserId);

      if (game.status === GameStatus.ABANDONED) {
        throw gameError(
          ErrorCodes.OPPONENT_LEFT,
          'Your opponent has left this game',
          409,
          'REMATCH_FAILED'
        );
      }

      const { rows } = await client.query(
        'SELECT user_id FROM knife_players WHERE game_id = $1 AND left_at IS NULL AND user_id <> $2',
        [gameId, normalizedUserId]
      );
      if (!rows[0]) {
        throw gameError(
          ErrorCodes.OPPONENT_LEFT,
          'Your opponent has left this game',
          409,
          'REMATCH_FAILED'
        );
      }

      if (game.status !== GameStatus.FINISHED) {
        throw gameError(
          ErrorCodes.GAME_NOT_FINISHED,
          'Rematch asked while the game is still playing',
          409,
          'REMATCH_FAILED'
        );
      }

      return { ok: true, opponentUserId: rows[0].user_id };
    });
  },

  /** Respond to a rematch request (accept or decline). */
  async respondRematch({ gameId, userId, accept }) {
    const normalizedUserId = String(userId).trim().toLowerCase();

    return await withTransaction(async (client) => {
      const game = await lockGame(client, gameId);
      await requireActivePlayer(client, gameId, normalizedUserId);

      if (game.status === GameStatus.ABANDONED) {
        throw gameError(
          ErrorCodes.OPPONENT_LEFT,
          'Your opponent has left this game',
          409,
          'REMATCH_FAILED'
        );
      }

      const opponentRes = await client.query(
        'SELECT user_id FROM knife_players WHERE game_id = $1 AND left_at IS NULL AND user_id <> $2',
        [gameId, normalizedUserId]
      );
      if (!opponentRes.rows[0]) {
        throw gameError(
          ErrorCodes.OPPONENT_LEFT,
          'Your opponent has left this game',
          409,
          'REMATCH_FAILED'
        );
      }
      const opponentUserId = opponentRes.rows[0].user_id;

      if (game.status !== GameStatus.FINISHED) {
        throw gameError(
          ErrorCodes.GAME_NOT_FINISHED,
          'Rematch asked while the game is still playing',
          409,
          'REMATCH_FAILED'
        );
      }

      if (!accept) {
        return { accepted: false, opponentUserId };
      }

      // Rematch accepted: round + 1, level 1, scores/hearts reset, new apples
      // Rule: "First throw red in round 1; the other colour starts each rematch"
      const nextRound = game.round + 1;
      const startColor = nextRound % 2 === 1 ? Colors.RED : Colors.BLUE;
      const initialApples = generateApples(1);
      const levelStartedAt = Date.now() + Config.LEVEL_PAUSE_MS;

      const updateRes = await client.query(
        `UPDATE knife_games
         SET round = $2,
             level = 1,
             level_started_at = $3,
             current_turn = $4,
             throw_number = 0,
             scores = $5,
             lives = $6,
             apples = $7,
             stuck_knives = $8,
             status = $9,
             winner = NULL,
             winner_user_id = NULL,
             is_draw = FALSE,
             end_reason = NULL,
             started_at = NOW(),
             finished_at = NULL,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          gameId,
          nextRound,
          levelStartedAt,
          startColor,
          JSON.stringify({ red: 0, blue: 0 }),
          JSON.stringify({ red: Config.LIVES, blue: Config.LIVES }),
          JSON.stringify(initialApples),
          JSON.stringify([]),
          GameStatus.PLAYING,
        ]
      );

      const players = await listPlayers(client, gameId);
      return {
        accepted: true,
        game: serializeGame(updateRes.rows[0]),
        players,
        opponentUserId,
      };
    });
  },

  /** Voluntary leave or forfeit due to timeout. */
  async leaveGame({ gameId, userId, reason = EndReason.OPPONENT_LEFT }) {
    const normalizedUserId = String(userId).trim().toLowerCase();

    return await withTransaction(async (client) => {
      const game = await lockGame(client, gameId);
      const player = await requireActivePlayer(client, gameId, normalizedUserId);

      await client.query(
        'UPDATE knife_players SET left_at = NOW() WHERE game_id = $1 AND user_id = $2',
        [gameId, normalizedUserId]
      );

      const isLive = game.status === GameStatus.PLAYING;
      if (!isLive && game.status !== GameStatus.WAITING) {
        // Leaving a finished game keeps results
        const players = await listPlayers(client, gameId);
        const opponent = players.find((p) => p.user_id !== normalizedUserId);
        return {
          game: serializeGame(game),
          abandoned: false,
          winner: game.winner,
          winnerUserId: game.winner_user_id,
          opponentUserId: opponent?.user_id ?? null,
        };
      }

      // Live game forfeit: remaining player wins whatever the score!
      const opponentColor = otherColor(player.color);
      const opponentRes = await client.query(
        'SELECT user_id FROM knife_players WHERE game_id = $1 AND user_id <> $2',
        [gameId, normalizedUserId]
      );
      const opponentUserId = opponentRes.rows[0]?.user_id ?? null;

      const updateRes = await client.query(
        `UPDATE knife_games
         SET status = $2,
             current_turn = NULL,
             winner = $3,
             winner_user_id = $4,
             is_draw = FALSE,
             end_reason = $5,
             finished_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          gameId,
          GameStatus.ABANDONED,
          isLive ? opponentColor : null,
          isLive ? opponentUserId : null,
          reason,
        ]
      );

      return {
        game: serializeGame(updateRes.rows[0]),
        abandoned: true,
        winner: isLive ? opponentColor : null,
        winnerUserId: isLive ? opponentUserId : null,
        opponentUserId,
      };
    });
  },

  /** Reaps games inactive longer than maxIdleHours */
  async reapStaleGames(maxIdleHours = 24) {
    const { rowCount } = await pool.query(
      `DELETE FROM knife_games WHERE updated_at < NOW() - ($1 * INTERVAL '1 hour')`,
      [maxIdleHours]
    );
    return rowCount || 0;
  },
};

