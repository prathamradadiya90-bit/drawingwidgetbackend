import { pool } from '../config/db.js';

export const chatService = {
  /**
   * Save a chat message in a room
   */
  async saveChat({ id, roomId, userId, message, createdAt = new Date().toISOString() }) {
    const { rowCount } = await pool.query(
      `INSERT INTO room_chats (id, room_id, user_id, message, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [id, roomId, userId, message, createdAt]
    );
    return (rowCount || 0) > 0;
  },

  /**
   * List all chat messages in a room
   */
  async listChats(roomId) {
    const { rows } = await pool.query(
      `SELECT c.id, c.room_id, c.user_id, COALESCE(m.name, 'Unknown') AS name, c.message, c.created_at
       FROM room_chats c
       LEFT JOIN room_members m ON m.room_id = c.room_id AND m.user_id = c.user_id
       WHERE c.room_id = $1
       ORDER BY c.created_at ASC`,
      [roomId]
    );
    return rows;
  },
};
