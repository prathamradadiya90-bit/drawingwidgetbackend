import http from 'node:http';
import app from './app.js';
import { config } from './config/index.js';
import { closePool } from './config/db.js';
import { initializeSocket } from './sockets/index.js';
import { startRoomReaper, stopRoomReaper } from './services/reaper.service.js';
import { logger } from './helpers/logger.js';

const server = http.createServer(app);

// Initialize Socket.IO for real-time multiplayer drawing
const io = initializeSocket(server);

// Start server
server.listen(config.port, () => {
  logger.info(`Server running on http://localhost:${config.port}`);
  logger.info(`Health check available at http://localhost:${config.port}/health`);
  logger.info(`Multiplayer rooms API available at http://localhost:${config.port}/api/v1/rooms`);

  // Start background room reaper
  startRoomReaper();
});

// Graceful shutdown handling
const shutdown = async (signal) => {
  logger.info(`${signal} received: closing HTTP server and database pool...`);
  stopRoomReaper();

  server.close(async () => {
    logger.info('HTTP server closed.');
    await closePool();
    logger.info('Database pool closed. Exiting process.');
    process.exit(0);
  });

  // Force exit if not closed within 10 seconds
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { server, io };
