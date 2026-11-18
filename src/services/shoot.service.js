import { pool, withTransaction } from '../config/db.js';
import { DeviceTypes, ErrorCodes, ShootGame } from '../helpers/constants.js';
import { ServiceError, generateRoomCode, getDefaultUserName } from './room.service.js';
import {
  CONFIG,
  scoreShot,
  crosshairAt,
  newPath,
  segmentMs,
  redoPathForTurn,
} from './shoot.math.js';

const { GameStatus, EndReason, Colors, Config } = ShootGame;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function gameError(reason, message, statusCode = 409, code = 'SHOT_FAILED') {
  const error = new ServiceError(message, statusCode);
  error.reason = reason;
  error.code = code;
  return error;
}

export const otherColor = (color) => (color === Colors.BLUE ? Colors.RED : Colors.BLUE);

function parseJson(val, fallback) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
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

export function serializeGame(row, shots = []) {
  const scores = parseJson(row.scores, { blue: 0, red: 0 });
  const shotsLeft = parseJson(row.shots_left, { blue: 5, red: 5 });
  const config = parseJson(row.config, Config);

  const totalShots = (config.max_shots - shotsLeft.blue) + (config.max_shots - shotsLeft.red);
  const shotRoundNum = Math.min(config.max_shots, Math.floor(totalShots / 2) + 1);

  const isPlaying = row.status === GameStatus.PLAYING;
  const turn =
    isPlaying && row.current_turn
      ? {
          color: row.current_turn,
          shot_number: Number(row.shot_number) + 1,
          started_at: Number(row.turn_started_at || 0),
          deadline_at: row.turn_deadline_at ? Number(row.turn_deadline_at) : null,
          path_progress: Number(row.turn_path_progress || 0),
          segment_ms: Number(row.turn_segment_ms || config.base_segment_ms),
          path: parseJson(row.turn_path, []),
        }
      : null;

  return {
    id: row.id,
    code: row.code,
    host_id: row.host_id,
    status: row.status,
    round: Number(row.round),
    first_turn: row.first_turn,
    current_turn: isPlaying ? row.current_turn : null,
    shot_number: Number(row.shot_number),
    shot_round: shotRoundNum,
    scores,
    shots_left: shotsLeft,
    shots,
    turn,
    server_time: Date.now(),
    winner: row.winner,
    winner_user_id: row.winner_user_id,
    is_draw: Boolean(row.is_draw),
    end_reason: row.end_reason,
    config,
  };
}

async function lockGame(client, gameId) {
  const { rows } = await client.query('SELECT * FROM shoot_games WHERE id = $1 FOR UPDATE', [
    gameId,
  ]);
  const game = rows[0];
  if (!game) {
    throw new ServiceError(`Game ${gameId} not found`, 404);
  }
  return game;
}

async function listPlayers(client, gameId) {
  const { rows } = await client.query(
    'SELECT * FROM shoot_players WHERE game_id = $1 ORDER BY joined_at ASC',
    [gameId]
  );
  return rows.map(serializePlayer);
}

async function listShotsForRound(client, gameId, round) {
  const { rows } = await client.query(
    `SELECT shot_number, color, user_id, x, y, points, elapsed_ms, auto
     FROM shoot_shots
     WHERE game_id = $1 AND round = $2
     ORDER BY shot_number ASC`,
    [gameId, round]
  );
  return rows.map((r) => ({
    shot_number: Number(r.shot_number),
    color: r.color,
    user_id: r.user_id,
    x: Number(r.x),
    y: Number(r.y),
    points: Number(r.points),
    elapsed_ms: Number(r.elapsed_ms),
    auto: Boolean(r.auto),
  }));
}

async function requireActivePlayer(client, gameId, normalizedUserId) {
  const { rows } = await client.query(
    'SELECT * FROM shoot_players WHERE game_id = $1 AND user_id = $2',
    [gameId, normalizedUserId]
  );
  const player = rows[0];
  if (!player || player.left_at) {
    throw gameError(
      ErrorCodes.NOT_IN_GAME,
      'You are not in this game',
      403,
      ErrorCodes.NOT_IN_GAME
    );
  }
  return player;
}

export const shootGameService = {
  /**
   * Create a new Shoot Game. Host is assigned 'blue' and status is 'waiting'.
   */
  async createGame({ name, profileImage = null, hostId, deviceType = DeviceTypes.IOS }) {
    if (!hostId) {
      throw new ServiceError('Host ID (x-user-id header) is required', 401);
    }
    const normalizedHostId = String(hostId).trim().toLowerCase();

    return await withTransaction(async (client) => {
      let code;
      let collision = true;
      let attempts = 0;
      while (collision && attempts < 10) {
        attempts++;
        code = generateRoomCode();
        const existing = await client.query('SELECT 1 FROM shoot_games WHERE code = $1', [code]);
        if (existing.rows.length === 0) collision = false;
      }
      if (collision) {
        throw new ServiceError('Failed to generate unique room code. Please try again.', 500);
      }

      const gameRes = await client.query(
        `INSERT INTO shoot_games (code, host_id, status, round, first_turn, current_turn, shot_number, scores, shots_left, config)
         VALUES ($1, $2, $3, 1, $4, NULL, 0, $5, $6, $7)
         RETURNING *`,
        [
          code,
          normalizedHostId,
          GameStatus.WAITING,
          Colors.BLUE,
          JSON.stringify({ [Colors.BLUE]: 0, [Colors.RED]: 0 }),
          JSON.stringify({ [Colors.BLUE]: Config.max_shots, [Colors.RED]: Config.max_shots }),
          JSON.stringify(Config),
        ]
      );
      const gameRow = gameRes.rows[0];

      await client.query(
        `INSERT INTO shoot_players (game_id, user_id, color, name, profile_image, device_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          gameRow.id,
          normalizedHostId,
          Colors.BLUE,
          name || getDefaultUserName(normalizedHostId),
          profileImage,
          deviceType,
        ]
      );

      const players = await listPlayers(client, gameRow.id);
      return {
        game: serializeGame(gameRow, []),
        color: Colors.BLUE,
        players,
      };
    });
  },

  /**
   * Join an existing game by code as 'red'.
   * Status transitions to 'playing'. Host is notified via socket.
   */
  async joinGame({ code, name, profileImage = null, userId, deviceType = DeviceTypes.IOS }) {
    if (!code || typeof code !== 'string') {
      throw new ServiceError('Game code is required', 422);
    }
    const normalizedCode = code.trim().toUpperCase();
    const normalizedUserId = String(userId).trim().toLowerCase();

    return await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM shoot_games WHERE code = $1 FOR UPDATE', [
        normalizedCode,
      ]);
      let game = rows[0];
      if (!game) {
        throw new ServiceError(`No game found with code ${normalizedCode}`, 404);
      }

      const seatRes = await client.query(
        'SELECT * FROM shoot_players WHERE game_id = $1 AND user_id = $2',
        [game.id, normalizedUserId]
      );
      const existing = seatRes.rows[0];

      if (existing?.left_at) {
        throw new ServiceError('You have already left this game', 409);
      }

      if (existing) {
        const shots = await listShotsForRound(client, game.id, game.round);
        const players = await listPlayers(client, game.id);
        return {
          game: serializeGame(game, shots),
          color: existing.color,
          players,
        };
      }

      if (game.status !== GameStatus.WAITING) {
        throw new ServiceError('This game is full or has already ended', 409);
      }

      await client.query(
        `INSERT INTO shoot_players (game_id, user_id, color, name, profile_image, device_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          game.id,
          normalizedUserId,
          Colors.RED,
          name || getDefaultUserName(normalizedUserId),
          profileImage,
          deviceType,
        ]
      );

      // Generate initial 100-spot random path
      const path = newPath(Config);
      const startedAt = Date.now() + Config.start_delay_ms;
      const deadlineAt = startedAt + Config.turn_timeout_ms;

      const started = await client.query(
        `UPDATE shoot_games
         SET status = $2,
             current_turn = $3,
             turn_started_at = $4,
             turn_deadline_at = $5,
             turn_path_progress = 0,
             turn_segment_ms = $6,
             turn_path = $7,
             started_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          game.id,
          GameStatus.PLAYING,
          Colors.BLUE,
          startedAt,
          deadlineAt,
          Config.base_segment_ms,
          JSON.stringify(path),
        ]
      );
      game = started.rows[0];

      const shots = await listShotsForRound(client, game.id, game.round);
      const players = await listPlayers(client, game.id);

      return {
        game: serializeGame(game, shots),
        color: Colors.RED,
        players,
      };
    });
  },

  /** Get game by ID */
  async getGame(gameId) {
    if (!gameId || !UUID_REGEX.test(gameId)) {
      throw new ServiceError('Invalid game ID format', 404);
    }
    const { rows } = await pool.query('SELECT * FROM shoot_games WHERE id = $1', [gameId]);
    if (rows.length === 0) {
      throw new ServiceError(`Game ${gameId} not found`, 404);
    }
    const shots = await listShotsForRound(pool, gameId, rows[0].round);
    const players = await listPlayers(pool, gameId);
    return { game: serializeGame(rows[0], shots), players };
  },

  /** Get game by 6-char code */
  async getGameByCode(code) {
    if (!code || typeof code !== 'string') {
      throw new ServiceError('Game code is required', 422);
    }
    const normalizedCode = code.trim().toUpperCase();
    const { rows } = await pool.query('SELECT * FROM shoot_games WHERE code = $1', [normalizedCode]);
    if (rows.length === 0) {
      throw new ServiceError(`No game found with code ${normalizedCode}`, 404);
    }
    const shots = await listShotsForRound(pool, rows[0].id, rows[0].round);
    const players = await listPlayers(pool, rows[0].id);
    return { game: serializeGame(rows[0], shots), players };
  },

  /** Returns caller's seat and game state for socket join. Rejects non-players and players who left. */
  async getSeat({ gameId, userId }) {
    const normalizedUserId = String(userId).trim().toLowerCase();
    const { game, players } = await this.getGame(gameId);
    const seatRes = await pool.query(
      'SELECT * FROM shoot_players WHERE game_id = $1 AND user_id = $2 AND left_at IS NULL',
      [gameId, normalizedUserId]
    );
    const seat = seatRes.rows[0];
    if (!seat) {
      throw gameError(
        ErrorCodes.NOT_IN_GAME,
        'You are not a player in this game',
        403,
        ErrorCodes.NOT_IN_GAME
      );
    }
    return { game, players, color: seat.color };
  },

  /**
   * Updates turn start time when both sockets are in for the first time.
   */
  async markRoundStarted({ gameId, delayMs = Config.start_delay_ms }) {
    return await withTransaction(async (client) => {
      const gameRow = await lockGame(client, gameId);
      if (gameRow.status !== GameStatus.PLAYING) return null;

      const now = Date.now();
      const startedAt = now + delayMs;
      const deadlineAt = startedAt + Config.turn_timeout_ms;

      const updated = await client.query(
        `UPDATE shoot_games
         SET turn_started_at = $2,
             turn_deadline_at = $3,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [gameId, startedAt, deadlineAt]
      );
      const shots = await listShotsForRound(client, gameId, gameRow.round);
      const players = await listPlayers(client, gameId);
      return { game: serializeGame(updated.rows[0], shots), players };
    });
  },

  /**
   * Fire a shot on the crosshair path.
   * Atomic with row locking. Implements Section 7 checks, clamping, scoring, and state transitions.
   */
  async fireShot({
    gameId,
    userId,
    shotNumber,
    elapsedMs,
    clientX = null,
    clientY = null,
    auto = false,
  }) {
    const normalizedUserId = String(userId).trim().toLowerCase();
    const serverNow = Date.now();

    return await withTransaction(async (client) => {
      const gameRow = await lockGame(client, gameId);

      // Check 1: Sender is a player in this game
      const playerRes = await client.query(
        'SELECT * FROM shoot_players WHERE game_id = $1 AND user_id = $2',
        [gameId, normalizedUserId]
      );
      const player = playerRes.rows[0];
      if (!player || player.left_at) {
        throw gameError(
          ErrorCodes.NOT_IN_GAME,
          'You are not in this game',
          403,
          ErrorCodes.NOT_IN_GAME
        );
      }

      // Check 2: status == "playing"
      if (gameRow.status !== GameStatus.PLAYING) {
        throw gameError(
          ErrorCodes.GAME_NOT_ACTIVE,
          'The game is not being played',
          409,
          ErrorCodes.SHOT_FAILED
        );
      }

      // Check: shot_number == turn.shot_number (a retry of an already accepted shot returns STALE_SHOT)
      const expectedShotNumber = Number(gameRow.shot_number) + 1;
      if (shotNumber !== expectedShotNumber) {
        throw gameError(
          ErrorCodes.STALE_SHOT,
          'That shot was already counted',
          409,
          ErrorCodes.SHOT_FAILED
        );
      }

      // Check: turn.color is the sender's color
      if (gameRow.current_turn !== player.color) {
        throw gameError(
          ErrorCodes.NOT_YOUR_TURN,
          'It is not your turn',
          409,
          ErrorCodes.SHOT_FAILED
        );
      }

      const turnStartedAt = Number(gameRow.turn_started_at || 0);

      // Check 5: server_now >= turn.started_at - early_slack_ms
      if (!auto && serverNow < turnStartedAt - Config.early_slack_ms) {
        throw gameError(
          ErrorCodes.TURN_STARTING,
          'Wait for the crosshair to move',
          409,
          ErrorCodes.SHOT_FAILED
        );
      }

      // Check 6: elapsed_ms is a finite JSON number >= 0 (a string like "500" is refused)
      if (
        !auto &&
        (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0)
      ) {
        throw gameError(
          ErrorCodes.INVALID_TIME,
          'Invalid shot time',
          422,
          ErrorCodes.SHOT_FAILED
        );
      }

      // Check 7: elapsed_ms <= (server_now - turn.started_at) + early_slack_ms (not in the future)
      if (!auto && elapsedMs > (serverNow - turnStartedAt) + Config.early_slack_ms) {
        throw gameError(
          ErrorCodes.INVALID_TIME,
          'Invalid shot time',
          422,
          ErrorCodes.SHOT_FAILED
        );
      }

      // Clamping: Clamp, don't refuse, late shots
      const nowElapsed = Math.max(0, serverNow - turnStartedAt);
      let actualElapsedMs = auto ? Math.max(0, elapsedMs ?? Config.turn_timeout_ms) : elapsedMs;
      let adjusted = false;

      if (!auto && actualElapsedMs < nowElapsed - Config.late_slack_ms) {
        actualElapsedMs = Math.max(0, nowElapsed - Config.late_slack_ms);
        adjusted = true;
      }
      if (Config.turn_timeout_ms && actualElapsedMs > Config.turn_timeout_ms) {
        actualElapsedMs = Config.turn_timeout_ms;
        adjusted = true;
      }

      const path = parseJson(gameRow.turn_path, []);
      const turn = {
        path_progress: Number(gameRow.turn_path_progress || 0),
        segment_ms: Number(gameRow.turn_segment_ms || Config.base_segment_ms),
      };

      // Compute where crosshair was
      const { progress, x, y } = crosshairAt(path, turn, actualElapsedMs, Config);

      // Score shot
      const points = scoreShot(x, y, Config);

      const scores = parseJson(gameRow.scores, { blue: 0, red: 0 });
      const shotsLeft = parseJson(gameRow.shots_left, { blue: 5, red: 5 });

      scores[player.color] = (scores[player.color] || 0) + points;
      shotsLeft[player.color] = Math.max(0, (shotsLeft[player.color] || Config.max_shots) - 1);

      // Insert into shoot_shots history
      await client.query(
        `INSERT INTO shoot_shots (
           game_id, round, shot_number, color, user_id,
           x, y, points, elapsed_ms, adjusted, auto, path_progress
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          gameId,
          gameRow.round,
          expectedShotNumber,
          player.color,
          normalizedUserId,
          x,
          y,
          points,
          actualElapsedMs,
          adjusted,
          auto,
          progress,
        ]
      );

      const players = await listPlayers(client, gameId);
      const bluePlayer = players.find((p) => p.color === Colors.BLUE);
      const redPlayer = players.find((p) => p.color === Colors.RED);

      const totalShots = (Config.max_shots - shotsLeft.blue) + (Config.max_shots - shotsLeft.red);
      const isGameOver = shotsLeft.blue === 0 && shotsLeft.red === 0;

      let status = gameRow.status;
      let winner = null;
      let winnerUserId = null;
      let isDraw = false;
      let endReason = null;
      let nextTurn = null;
      let nextTurnColor = null;
      let nextTurnStartedAt = null;
      let nextTurnDeadlineAt = null;
      let nextTurnPathProgress = progress;
      let nextTurnSegmentMs = Number(gameRow.turn_segment_ms || Config.base_segment_ms);
      let nextTurnPath = path;

      const nextShotRound = Math.min(Config.max_shots, Math.floor(totalShots / 2) + 1);

      if (isGameOver) {
        status = GameStatus.FINISHED;
        endReason = EndReason.SCORE;
        nextTurnColor = null;

        if (scores.blue > scores.red) {
          winner = Colors.BLUE;
          winnerUserId = bluePlayer?.user_id ?? null;
          isDraw = false;
        } else if (scores.red > scores.blue) {
          winner = Colors.RED;
          winnerUserId = redPlayer?.user_id ?? null;
          isDraw = false;
        } else {
          winner = null;
          winnerUserId = null;
          isDraw = true;
        }
      } else {
        nextTurnColor = otherColor(player.color);
        nextTurnSegmentMs = segmentMs(nextShotRound, Config);

        // Run catch-up help for the next shooter (from shot round 2)
        redoPathForTurn(
          nextTurnPath,
          progress,
          nextShotRound,
          scores[nextTurnColor],
          scores[player.color],
          Config
        );

        const pauseMs = points === 50 ? Config.bullseye_pause_ms : Config.result_pause_ms;
        nextTurnStartedAt = serverNow + pauseMs;
        nextTurnDeadlineAt = Config.turn_timeout_ms ? nextTurnStartedAt + Config.turn_timeout_ms : null;

        nextTurn = {
          color: nextTurnColor,
          shot_number: expectedShotNumber + 1,
          started_at: nextTurnStartedAt,
          deadline_at: nextTurnDeadlineAt,
          path_progress: progress,
          segment_ms: nextTurnSegmentMs,
          path: nextTurnPath,
        };
      }

      // Update game row in database
      const updateRes = await client.query(
        `UPDATE shoot_games
         SET status = $2,
             current_turn = $3,
             shot_number = $4,
             scores = $5,
             shots_left = $6,
             turn_started_at = $7,
             turn_deadline_at = $8,
             turn_path_progress = $9,
             turn_segment_ms = $10,
             turn_path = $11,
             winner = $12,
             winner_user_id = $13,
             is_draw = $14,
             end_reason = $15,
             finished_at = CASE WHEN $16 THEN NOW() ELSE finished_at END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          gameId,
          status,
          nextTurnColor,
          expectedShotNumber,
          JSON.stringify(scores),
          JSON.stringify(shotsLeft),
          nextTurnStartedAt,
          nextTurnDeadlineAt,
          nextTurnPathProgress,
          nextTurnSegmentMs,
          JSON.stringify(nextTurnPath),
          winner,
          winnerUserId,
          isDraw,
          endReason,
          isGameOver,
        ]
      );

      const shot = {
        shot_number: expectedShotNumber,
        color: player.color,
        user_id: normalizedUserId,
        elapsed_ms: actualElapsedMs,
        adjusted,
        auto,
        x,
        y,
        path_progress: progress,
        points,
      };

      const shotResult = {
        game_id: gameId,
        shot,
        scores,
        shots_left: shotsLeft,
        next_turn: nextTurn,
        shot_round: nextShotRound,
        game_over: isGameOver,
        winner,
        winner_user_id: winnerUserId,
        is_draw: isDraw,
        server_time: serverNow,
      };

      const updatedGame = serializeGame(
        updateRes.rows[0],
        await listShotsForRound(client, gameId, gameRow.round)
      );

      return {
        shotResult,
        game: updatedGame,
        players,
        winner,
        winnerUserId,
        isDraw,
        reason: endReason,
        isGameOver,
      };
    });
  },

  /** Request a rematch after game finishes. Opponent must accept. */
  async requestRematch({ gameId, userId }) {
    const normalizedUserId = String(userId).trim().toLowerCase();
    return withTransaction(async (client) => {
      const game = await lockGame(client, gameId);
      await requireActivePlayer(client, gameId, normalizedUserId);

      if (game.status === GameStatus.ABANDONED) {
        throw gameError(
          ErrorCodes.OPPONENT_LEFT,
          'Your opponent has left this game',
          409,
          ErrorCodes.REMATCH_FAILED
        );
      }

      const { rows } = await client.query(
        'SELECT user_id FROM shoot_players WHERE game_id = $1 AND user_id <> $2 AND left_at IS NULL',
        [gameId, normalizedUserId]
      );
      if (rows.length === 0) {
        throw gameError(
          ErrorCodes.OPPONENT_LEFT,
          'Your opponent has left this game',
          409,
          ErrorCodes.REMATCH_FAILED
        );
      }

      if (game.status !== GameStatus.FINISHED) {
        throw gameError(
          ErrorCodes.GAME_NOT_FINISHED,
          'Rematch asked while the game is still playing',
          409,
          ErrorCodes.REMATCH_FAILED
        );
      }

      return { ok: true, opponentUserId: rows[0].user_id };
    });
  },

  /** Respond to a rematch request (accept or decline). */
  async respondRematch({ gameId, userId, accept }) {
    const normalizedUserId = String(userId).trim().toLowerCase();
    return withTransaction(async (client) => {
      const game = await lockGame(client, gameId);
      await requireActivePlayer(client, gameId, normalizedUserId);

      if (game.status === GameStatus.ABANDONED) {
        throw gameError(
          ErrorCodes.OPPONENT_LEFT,
          'Your opponent has left this game',
          409,
          ErrorCodes.REMATCH_FAILED
        );
      }

      const opponentRes = await client.query(
        'SELECT user_id FROM shoot_players WHERE game_id = $1 AND user_id <> $2 AND left_at IS NULL',
        [gameId, normalizedUserId]
      );
      if (opponentRes.rows.length === 0) {
        throw gameError(
          ErrorCodes.OPPONENT_LEFT,
          'Your opponent has left this game',
          409,
          ErrorCodes.REMATCH_FAILED
        );
      }
      const opponentUserId = opponentRes.rows[0].user_id;

      if (game.status !== GameStatus.FINISHED) {
        throw gameError(
          ErrorCodes.GAME_NOT_FINISHED,
          'Rematch asked while the game is still playing',
          409,
          ErrorCodes.REMATCH_FAILED
        );
      }

      if (!accept) {
        return { accepted: false, opponentUserId };
      }

      // First turn flips each rematch: round 1 blue, round 2 red, round 3 blue, etc.
      const newRound = Number(game.round) + 1;
      const newFirstTurn = otherColor(game.first_turn || Colors.BLUE);
      const newScores = { [Colors.BLUE]: 0, [Colors.RED]: 0 };
      const newShotsLeft = { [Colors.BLUE]: Config.max_shots, [Colors.RED]: Config.max_shots };

      const newPathList = newPath(Config);
      const startedAt = Date.now() + Config.start_delay_ms;
      const deadlineAt = startedAt + Config.turn_timeout_ms;

      const updated = await client.query(
        `UPDATE shoot_games
         SET status = $2,
             round = $3,
             first_turn = $4,
             current_turn = $4,
             shot_number = 0,
             scores = $5,
             shots_left = $6,
             turn_started_at = $7,
             turn_deadline_at = $8,
             turn_path_progress = 0,
             turn_segment_ms = $9,
             turn_path = $10,
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
          GameStatus.PLAYING,
          newRound,
          newFirstTurn,
          JSON.stringify(newScores),
          JSON.stringify(newShotsLeft),
          startedAt,
          deadlineAt,
          Config.base_segment_ms,
          JSON.stringify(newPathList),
        ]
      );

      const players = await listPlayers(client, gameId);
      return {
        accepted: true,
        game: serializeGame(updated.rows[0], []),
        players,
        opponentUserId,
      };
    });
  },

  /** Voluntarily leave game or forfeit on disconnect timeout. */
  async leaveGame({ gameId, userId, reason = EndReason.OPPONENT_LEFT }) {
    const normalizedUserId = String(userId).trim().toLowerCase();
    return withTransaction(async (client) => {
      const game = await lockGame(client, gameId);
      const player = await requireActivePlayer(client, gameId, normalizedUserId);

      await client.query(
        'UPDATE shoot_players SET left_at = NOW() WHERE game_id = $1 AND user_id = $2',
        [gameId, normalizedUserId]
      );

      const isLive = game.status === GameStatus.PLAYING;
      if (!isLive && game.status !== GameStatus.WAITING) {
        // Leaving a finished game keeps results
        const players = await listPlayers(client, gameId);
        const opponent = players.find((p) => p.user_id !== normalizedUserId);
        const shots = await listShotsForRound(client, gameId, game.round);
        return {
          game: serializeGame(game, shots),
          abandoned: false,
          winner: game.winner,
          winnerUserId: game.winner_user_id,
          opponentUserId: opponent?.user_id ?? null,
        };
      }

      // Waiting game abandoned by host OR live game forfeit to opponent
      const opponentColor = otherColor(player.color);
      const opponentRes = await client.query(
        'SELECT user_id FROM shoot_players WHERE game_id = $1 AND user_id <> $2',
        [gameId, normalizedUserId]
      );
      const opponentUserId = opponentRes.rows[0]?.user_id ?? null;

      const updateRes = await client.query(
        `UPDATE shoot_games
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

      const shots = await listShotsForRound(client, gameId, game.round);
      return {
        game: serializeGame(updateRes.rows[0], shots),
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
      `DELETE FROM shoot_games WHERE updated_at < NOW() - ($1 * INTERVAL '1 hour')`,
      [maxIdleHours]
    );
    return rowCount;
  },
};
