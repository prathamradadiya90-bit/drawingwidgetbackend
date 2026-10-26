import { roomService } from './room.service.js';
import { config } from '../config/index.js';
import { logger } from '../helpers/logger.js';

let reaperInterval = null;

export async function reapRooms() {
  try {
    const removedCount = await roomService.reapStaleRooms(config.room.ttlHours);
    if (removedCount > 0) {
      logger.info(`Reaped ${removedCount} stale room(s) idle > ${config.room.ttlHours}h`);
    }
  } catch (error) {
    logger.error('Room reaper task error:', error);
  }
}

// Optional Keep-Alive worker to prevent free-tier cold starts
async function pingKeepAlive() {
  const keepAliveUrl = process.env.KEEP_ALIVE_URL;
  if (!keepAliveUrl) return;

  try {
    const res = await fetch(keepAliveUrl);
    logger.info(`Keep-alive ping to ${keepAliveUrl} succeeded: status ${res.status}`);
  } catch (err) {
    logger.warn(`Keep-alive ping to ${keepAliveUrl} failed: ${err.message}`);
  }
}

/**
 * Start periodic reaper service and keep-alive worker
 */
export function startRoomReaper() {
  if (reaperInterval) return;

  reaperInterval = setInterval(reapRooms, config.room.reapIntervalMs);
  reaperInterval.unref();

  // Run initial check
  reapRooms();
  logger.info(`Room reaper started (interval: ${config.room.reapIntervalMs / 60000}m, TTL: ${config.room.ttlHours}h)`);

  // Start keep-alive ping every 14 minutes if KEEP_ALIVE_URL is configured
  if (process.env.KEEP_ALIVE_URL) {
    const FOURTEEN_MINUTES_MS = 14 * 60 * 1000;
    const keepAliveTimer = setInterval(pingKeepAlive, FOURTEEN_MINUTES_MS);
    keepAliveTimer.unref();
    pingKeepAlive();
    logger.info(`Keep-alive worker activated for ${process.env.KEEP_ALIVE_URL} (every 14m)`);
  }
}

/**
 * Stop periodic reaper service
 */
export function stopRoomReaper() {
  if (reaperInterval) {
    clearInterval(reaperInterval);
    reaperInterval = null;
  }
}
