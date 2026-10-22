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

/**
 * Start periodic reaper service
 */
export function startRoomReaper() {
  if (reaperInterval) return;

  reaperInterval = setInterval(reapRooms, config.room.reapIntervalMs);
  reaperInterval.unref();

  // Run initial check
  reapRooms();
  logger.info(`Room reaper started (interval: ${config.room.reapIntervalMs / 60000}m, TTL: ${config.room.ttlHours}h)`);
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
