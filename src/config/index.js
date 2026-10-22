import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  database: {
    url: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/lockscreen_drawing',
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  },
  room: {
    ttlHours: Number(process.env.ROOM_TTL_HOURS || 24),
    reapIntervalMs: Number(process.env.ROOM_REAP_INTERVAL_MINUTES || 60) * 60 * 1000,
  },
};
