import { pool, withTransaction } from '../config/db.js';
import { DeviceTypes, ErrorCodes, TicTacToe } from '../helpers/constants.js';
import { ServiceError, generateRoomCode, getDefaultUserName } from './room.service.js';

const { GameStatus, EndReason, Symbols, WIN_LINES, EMPTY_CELL, BOARD_SIZE } = TicTacToe;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A rejected game action. `reason` tells clients why, without parsing the message. */
function gameError(reason, message, statusCode = 409) {
  const error = new ServiceError(message, statusCode);
  error.reason = reason;
  return error;
}

const otherSymbol = (symbol) => (symbol === Symbols.X ? Symbols.O : Symbols.X);

/** Returns the completed line for `board` (a 9 char string), or null. */
export function findWinningLine(board) {
  return (
    WIN_LINES.find(
      ([a, b, c]) => board[a] !== EMPTY_CELL && board[a] === board[b] && board[a] === board[c]
    ) || null
  );
}

function serializeGame(row) {
  return {
    id: row.id,
    code: row.code,
    host_id: row.host_id,
    status: row.status,
    board: [...row.board].map((cell) => (cell === EMPTY_CELL ? null : cell)),
    current_turn: row.current_turn,
    winner: row.winner,
    winning_line: row.winning_line,
    is_draw: row.end_reason === EndReason.DRAW,
    end_reason: row.end_reason,
    round: row.round,
    move_count: row.move_count,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

function serializePlayer(row) {
  return {
    user_id: row.user_id,
    symbol: row.symbol,
    name: row.name,
    profile_image: row.profile_image,
    device_type: row.device_type,
    joined_at: row.joined_at,
    left_at: row.left_at,
  };
}

async function listPlayers(db, gameId) {
  const { rows } = await db.query(
    'SELECT * FROM ttt_players WHERE game_id = $1 ORDER BY joined_at, user_id',
    [gameId]
  );
  return rows.map(serializePlayer);
}

/** Locks the game row, serializing every state change on a single game. */
async function lockGame(client, gameId) {
  if (typeof gameId !== 'string' || !UUID_REGEX.test(gameId)) {
    throw gameError(ErrorCodes.GAME_NOT_FOUND, 'Game not found', 404);
  }
  const { rows } = await client.query('SELECT * FROM ttt_games WHERE id = $1 FOR UPDATE', [gameId]);
  if (!rows[0]) {
    throw gameError(ErrorCodes.GAME_NOT_FOUND, 'Game not found', 404);
  }
  return rows[0];
}

async function requireActivePlayer(client, gameId, userId) {
  const { rows } = await client.query(
    'SELECT * FROM ttt_players WHERE game_id = $1 AND user_id = $2 AND left_at IS NULL',
    [gameId, userId]
  );
  if (!rows[0]) {
    throw gameError(ErrorCodes.NOT_IN_GAME, 'You are not a player in this game', 403);
  }
  return rows[0];
}

export const ticTacToeService = {
  /** Create a game. The creator plays X and waits for an opponent. */
  async createGame({ name, profileImage = null, hostId, deviceType = DeviceTypes.IOS }) {
    return await withTransaction(async (client) => {
      let game = null;
      for (let attempt = 0; attempt < 20 && !game; attempt++) {
        const { rows } = await client.query(
          `INSERT INTO ttt_games (code, host_id) VALUES ($1, $2)
           ON CONFLICT (code) DO NOTHING
           RETURNING *`,
          [generateRoomCode(), hostId]
        );
        game = rows[0];
      }
      if (!game) {
        throw new ServiceError('Could not allocate a unique game code. Please try again.', 500);
      }

      await client.query(
        `INSERT INTO ttt_players (game_id, user_id, symbol, name, profile_image, device_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [game.id, hostId, Symbols.X, name || getDefaultUserName(hostId), profileImage, deviceType]
      );

      return {
        game: serializeGame(game),
        symbol: Symbols.X,
        players: await listPlayers(client, game.id),
      };
    });
  },

  /**
   * Join by code as O, which starts the game. Calling again as a current player
   * returns that player's seat, so clients can safely retry.
   */
  async joinGame({ code, name, profileImage = null, userId, deviceType = DeviceTypes.IOS }) {
    if (!code || typeof code !== 'string') {
      throw new ServiceError('Game code is required', 422);
    }
    const normalizedCode = code.trim().toUpperCase();

    return await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM ttt_games WHERE code = $1 FOR UPDATE', [
        normalizedCode,
      ]);
      let game = rows[0];
      if (!game) {
        throw new ServiceError(`No game found with code ${normalizedCode}`, 404);
      }

      const seat = await client.query(
        'SELECT * FROM ttt_players WHERE game_id = $1 AND user_id = $2',
        [game.id, userId]
      );
      const existing = seat.rows[0];
      if (existing?.left_at) {
        throw new ServiceError('You have already left this game', 409);
      }

      if (!existing) {
        if (game.status !== GameStatus.WAITING) {
          throw new ServiceError('This game is full or has already ended', 409);
        }
        await client.query(
          `INSERT INTO ttt_players (game_id, user_id, symbol, name, profile_image, device_type)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [game.id, userId, Symbols.O, name || getDefaultUserName(userId), profileImage, deviceType]
        );
        const started = await client.query(
          `UPDATE ttt_games
           SET status = $2, current_turn = $3, started_at = NOW(), updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [game.id, GameStatus.PLAYING, Symbols.X]
        );
        game = started.rows[0];
      }

      return {
        game: serializeGame(game),
        symbol: existing?.symbol ?? Symbols.O,
        players: await listPlayers(client, game.id),
      };
    });
  },

  async getGame(gameId) {
    if (typeof gameId !== 'string' || !UUID_REGEX.test(gameId)) {
      throw gameError(ErrorCodes.GAME_NOT_FOUND, 'Game not found', 404);
    }
    const { rows } = await pool.query('SELECT * FROM ttt_games WHERE id = $1', [gameId]);
    if (!rows[0]) {
      throw gameError(ErrorCodes.GAME_NOT_FOUND, 'Game not found', 404);
    }
    return { game: serializeGame(rows[0]), players: await listPlayers(pool, gameId) };
  },

  async getGameByCode(code) {
    const normalizedCode = String(code || '').trim().toUpperCase();
    const { rows } = await pool.query('SELECT * FROM ttt_games WHERE code = $1', [normalizedCode]);
    if (!rows[0]) {
      throw gameError(ErrorCodes.GAME_NOT_FOUND, `No game found with code ${normalizedCode}`, 404);
    }
    return { game: serializeGame(rows[0]), players: await listPlayers(pool, rows[0].id) };
  },

  /** Moves for one round, oldest first. Defaults to the current round. */
  async listMoves(gameId, round) {
    const { game } = await this.getGame(gameId);
    const { rows } = await pool.query(
      `SELECT id, round, move_number, user_id, symbol, cell_index, created_at
       FROM ttt_moves
       WHERE game_id = $1 AND round = $2
       ORDER BY move_number`,
      [gameId, round ?? game.round]
    );
    return rows;
  },

  /** The caller's seat in a game, for socket join. Rejects non-players and players who left. */
  async getSeat({ gameId, userId }) {
    const { game, players } = await this.getGame(gameId);
    const seat = players.find((player) => player.user_id === userId && !player.left_at);
    if (!seat) {
      throw gameError(ErrorCodes.NOT_IN_GAME, 'You are not a player in this game', 403);
    }
    return { game, players, symbol: seat.symbol };
  },

  /** Validate and apply one move. The server alone decides turns, wins and draws. */
  async makeMove({ gameId, userId, cellIndex }) {
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= BOARD_SIZE) {
      throw gameError('INVALID_CELL', 'cell_index must be an integer from 0 to 8', 422);
    }

    return await withTransaction(async (client) => {
      const game = await lockGame(client, gameId);
      const player = await requireActivePlayer(client, gameId, userId);

      if (game.status !== GameStatus.PLAYING) {
        throw gameError('GAME_NOT_ACTIVE', 'This game is not in progress');
      }
      if (game.current_turn !== player.symbol) {
        throw gameError('NOT_YOUR_TURN', 'It is not your turn');
      }
      if (game.board[cellIndex] !== EMPTY_CELL) {
        throw gameError('CELL_OCCUPIED', 'That cell is already taken');
      }

      const board =
        game.board.slice(0, cellIndex) + player.symbol + game.board.slice(cellIndex + 1);
      const moveNumber = game.move_count + 1;
      const winningLine = findWinningLine(board);
      const isOver = Boolean(winningLine) || moveNumber === BOARD_SIZE;

      const updated = await client.query(
        `UPDATE ttt_games
         SET board = $2, move_count = $3, current_turn = $4, status = $5, winner = $6,
             winning_line = $7, end_reason = $8,
             finished_at = CASE WHEN $9 THEN NOW() END, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          gameId,
          board,
          moveNumber,
          isOver ? null : otherSymbol(player.symbol),
          isOver ? GameStatus.FINISHED : GameStatus.PLAYING,
          winningLine ? player.symbol : null,
          winningLine,
          isOver ? (winningLine ? EndReason.WIN : EndReason.DRAW) : null,
          isOver,
        ]
      );
      await client.query(
        `INSERT INTO ttt_moves (game_id, round, move_number, user_id, symbol, cell_index)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [gameId, game.round, moveNumber, userId, player.symbol, cellIndex]
      );

      return {
        game: serializeGame(updated.rows[0]),
        symbol: player.symbol,
        moveNumber,
        winnerUserId: winningLine ? userId : null,
      };
    });
  },

  /** Rematch: clear the board and swap symbols, so whoever went second goes first (X always starts). */
  async restartGame({ gameId, userId }) {
    return await withTransaction(async (client) => {
      const game = await lockGame(client, gameId);
      await requireActivePlayer(client, gameId, userId);

      if (game.status !== GameStatus.FINISHED) {
        throw gameError('GAME_NOT_FINISHED', 'Only a finished game can be restarted');
      }
      const { rowCount } = await client.query(
        'SELECT 1 FROM ttt_players WHERE game_id = $1 AND left_at IS NULL',
        [gameId]
      );
      if (rowCount < 2) {
        throw gameError('OPPONENT_LEFT', 'Your opponent has left this game');
      }

      await client.query(
        `UPDATE ttt_players SET symbol = CASE symbol WHEN 'X' THEN 'O' ELSE 'X' END WHERE game_id = $1`,
        [gameId]
      );
      const { rows } = await client.query(
        `UPDATE ttt_games
         SET board = DEFAULT, status = $2, current_turn = $3, winner = NULL, winning_line = NULL,
             end_reason = NULL, round = round + 1, move_count = 0, started_at = NOW(),
             finished_at = NULL, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [gameId, GameStatus.PLAYING, Symbols.X]
      );

      const players = await listPlayers(client, gameId);
      return {
        game: serializeGame(rows[0]),
        players,
        symbol: players.find((player) => player.user_id === userId).symbol,
      };
    });
  },

  /**
   * Remove a player. Leaving a live game forfeits it to the opponent; leaving a
   * waiting game cancels it; leaving a finished game keeps the result but rules out a rematch.
   */
  async leaveGame({ gameId, userId, reason = EndReason.OPPONENT_LEFT }) {
    return await withTransaction(async (client) => {
      const game = await lockGame(client, gameId);
      const player = await requireActivePlayer(client, gameId, userId);

      await client.query(
        'UPDATE ttt_players SET left_at = NOW() WHERE game_id = $1 AND user_id = $2',
        [gameId, userId]
      );

      const isLive = game.status === GameStatus.PLAYING;
      if (!isLive && game.status !== GameStatus.WAITING) {
        return { game: serializeGame(game), abandoned: false, winnerUserId: null };
      }

      const { rows } = await client.query(
        `UPDATE ttt_games
         SET status = $2, current_turn = NULL, winner = $3, end_reason = $4,
             finished_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          gameId,
          GameStatus.ABANDONED,
          isLive ? otherSymbol(player.symbol) : null,
          isLive ? reason : null,
        ]
      );

      let winnerUserId = null;
      if (isLive) {
        const opponent = await client.query(
          'SELECT user_id FROM ttt_players WHERE game_id = $1 AND user_id <> $2',
          [gameId, userId]
        );
        winnerUserId = opponent.rows[0]?.user_id ?? null;
      }

      return { game: serializeGame(rows[0]), abandoned: true, winnerUserId };
    });
  },

  /** Delete games with no activity for longer than `maxIdleHours`. */
  async reapStaleGames(maxIdleHours = 24) {
    const { rowCount } = await pool.query(
      `DELETE FROM ttt_games WHERE updated_at < NOW() - ($1 * INTERVAL '1 hour')`,
      [maxIdleHours]
    );
    return rowCount || 0;
  },
};
