import { pool } from '../config/db.js';

export const strokeService = {
  /**
   * Save an iOS stroke (PKDrawing base64 representation)
   */
  async saveStroke({ id, roomId, userId, stepIndex, kind = 'line', strokeData, createdAt = new Date().toISOString() }) {
    const { rowCount } = await pool.query(
      `INSERT INTO room_strokes
         (id, room_id, user_id, step_index, kind, stroke_data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [id, roomId, userId, stepIndex, kind, strokeData, createdAt]
    );
    return (rowCount || 0) > 0;
  },

  /**
   * Erase specific strokes from a room
   */
  async eraseStrokes(roomId, userId, strokeIds) {
    if (!Array.isArray(strokeIds) || strokeIds.length === 0) return 0;
    const { rowCount } = await pool.query(
      `DELETE FROM room_strokes
       WHERE room_id = $1 AND user_id = $2 AND id = ANY($3::uuid[])`,
      [roomId, userId, strokeIds]
    );
    return rowCount || 0;
  },

  /**
   * Retrieve all strokes for a room in chronological order
   */
  async listStrokes(roomId) {
    const { rows } = await pool.query(
      `SELECT id, room_id, user_id, step_index, kind, stroke_data, created_at
       FROM room_strokes
       WHERE room_id = $1
       ORDER BY created_at ASC`,
      [roomId]
    );
    return rows;
  },

  /**
   * Save Android-specific stroke event
   */
  async saveAndroidStroke({ id, roomId, userId, eventType, strokeData, createdAt = new Date().toISOString() }) {
    const { rowCount } = await pool.query(
      `INSERT INTO room_android_strokes
         (id, room_id, user_id, event_type, stroke_data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [id, roomId, userId, eventType, typeof strokeData === 'object' ? JSON.stringify(strokeData) : strokeData || '{}', createdAt]
    );
    return (rowCount || 0) > 0;
  },

  /**
   * Retrieve all Android strokes for a room in chronological order
   */
  async listAndroidStrokes(roomId) {
    const { rows } = await pool.query(
      `SELECT id, room_id, user_id, event_type, stroke_data, created_at
       FROM room_android_strokes
       WHERE room_id = $1
       ORDER BY created_at ASC`,
      [roomId]
    );
    return rows;
  },
};
