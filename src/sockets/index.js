import { Server } from 'socket.io';
import { socketAuth } from './auth.socket.js';
import { registerSocketEvents } from './events.js';
import { SocketLimits } from '../helpers/constants.js';
import { logger } from '../helpers/logger.js';

/**
 * Initialize Socket.IO with CORS, buffer limits, and authentication
 */
export function initializeSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    maxHttpBufferSize: SocketLimits.MAX_STROKE_DATA_LEN,
    pingTimeout: SocketLimits.PING_TIMEOUT_MS,
    pingInterval: SocketLimits.PING_INTERVAL_MS,
    connectTimeout: 45_000,
    transports: ['websocket', 'polling'],
  });

  // Attach to /v1 namespace (primary iOS/Android namespace)
  const v1Namespace = io.of('/v1');
  v1Namespace.use(socketAuth);
  v1Namespace.on('connection', (socket) => {
    registerSocketEvents(socket, io);
  });

  // Also attach to default namespace for maximum client compatibility
  io.use(socketAuth);
  io.on('connection', (socket) => {
    registerSocketEvents(socket, io);
  });

  logger.info('Socket.IO initialized on "/" and "/v1" namespaces');
  return io;
}

export default initializeSocket;
