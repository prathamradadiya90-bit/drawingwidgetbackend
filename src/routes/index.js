import { Router } from 'express';
import roomRoutes from './room.routes.js';
import ticTacToeRoutes from './tictactoe.routes.js';
import knifeRoutes from './knife.routes.js';
import shootRoutes from './shoot.routes.js';

export const apiRouter = Router();

apiRouter.get('/', (req, res) => {
  res.json({
    message: 'Drawing Widget API is online',
    version: '1.0.0',
    endpoints: {
      rooms: '/api/v1/rooms',
      tictactoe: '/api/v1/tictactoe',
      knife: '/api/v1/knife',
      shoot: '/api/v1/shoot',
    },
  });
});

// Multiplayer Room Endpoints (supports both /v1/rooms and /rooms)
apiRouter.use('/v1/rooms', roomRoutes);
apiRouter.use('/rooms', roomRoutes);

// Tic Tac Toe Endpoints (supports both /v1/tictactoe and /tictactoe)
apiRouter.use('/v1/tictactoe', ticTacToeRoutes);
apiRouter.use('/tictactoe', ticTacToeRoutes);

// Knife Game Endpoints (supports both /v1/knife and /knife)
apiRouter.use('/v1/knife', knifeRoutes);
apiRouter.use('/knife', knifeRoutes);

// Shoot Game Endpoints (supports both /v1/shoot and /shoot)
apiRouter.use('/v1/shoot', shootRoutes);
apiRouter.use('/shoot', shootRoutes);
