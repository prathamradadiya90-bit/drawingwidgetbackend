import { Router } from 'express';
import roomRoutes from './room.routes.js';
import ticTacToeRoutes from './tictactoe.routes.js';
import knifeRoutes from './knife.routes.js';
import shootRoutes from './shoot.routes.js';
import userRoutes from './user.routes.js';
import friendRoutes from './friend.routes.js';
import friendRequestRoutes from './friend_request.routes.js';
import notificationRoutes from './notification.routes.js';

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
      users: '/api/v1/users',
      friends: '/api/v1/friends',
      friend_requests: '/api/v1/friend-requests',
      notifications: '/api/v1/notifications',
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

// User & Registration Endpoints (supports both /v1/users and /users)
apiRouter.use('/v1/users', userRoutes);
apiRouter.use('/users', userRoutes);

// Friends Endpoints (supports both /v1/friends and /friends)
apiRouter.use('/v1/friends', friendRoutes);
apiRouter.use('/friends', friendRoutes);

// Friend Requests Endpoints (supports both /v1/friend-requests and /friend-requests)
apiRouter.use('/v1/friend-requests', friendRequestRoutes);
apiRouter.use('/friend-requests', friendRequestRoutes);

// Notifications Endpoints (supports both /v1/notifications and /notifications)
apiRouter.use('/v1/notifications', notificationRoutes);
apiRouter.use('/notifications', notificationRoutes);
