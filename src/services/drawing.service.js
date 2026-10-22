// In-memory drawing store (ready to connect with MongoDB / PostgreSQL / SQLite)
const drawings = new Map();

export const drawingService = {
  async getAllDrawings() {
    return Array.from(drawings.values());
  },

  async getDrawingById(id) {
    return drawings.get(id) || null;
  },

  async createDrawing(data) {
    const id = data.id || `drawing_${Date.now()}`;
    const newDrawing = {
      id,
      title: data.title || 'Untitled Drawing',
      strokes: data.strokes || [],
      thumbnail: data.thumbnail || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    drawings.set(id, newDrawing);
    return newDrawing;
  },

  async updateDrawing(id, updates) {
    const existing = drawings.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    drawings.set(id, updated);
    return updated;
  },

  async deleteDrawing(id) {
    return drawings.delete(id);
  },
};
