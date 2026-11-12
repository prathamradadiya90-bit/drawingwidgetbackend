import { Router } from 'express';
import roomRoutes from './room.routes.js';
import ticTacToeRoutes from './tictactoe.routes.js';

export const apiRouter = Router();

apiRouter.get('/', (req, res) => {
  res.json({
    message: 'Drawing Widget API is online',
    version: '1.0.0',
    endpoints: {
      rooms: '/api/v1/rooms',
      tictactoe: '/api/v1/tictactoe',
    },
  });
});

// Multiplayer Room Endpoints (supports both /v1/rooms and /rooms)
apiRouter.use('/v1/rooms', roomRoutes);
apiRouter.use('/rooms', roomRoutes);

// Tic Tac Toe Endpoints (supports both /v1/tictactoe and /tictactoe)
apiRouter.use('/v1/tictactoe', ticTacToeRoutes);
apiRouter.use('/tictactoe', ticTacToeRoutes);
