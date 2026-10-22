import { Router } from 'express';
import roomRoutes from './room.routes.js';

export const apiRouter = Router();

apiRouter.get('/', (req, res) => {
  res.json({
    message: 'Drawing Widget API is online',
    version: '1.0.0',
    endpoints: {
      rooms: '/api/v1/rooms',
    },
  });
});

// Multiplayer Room Endpoints (supports both /v1/rooms and /rooms)
apiRouter.use('/v1/rooms', roomRoutes);
apiRouter.use('/rooms', roomRoutes);
