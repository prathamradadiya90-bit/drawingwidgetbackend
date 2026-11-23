import { Router } from 'express';
import { roomController } from '../controllers/room.controller.js';
import { requireUser } from '../middlewares/auth.middleware.js';

const router = Router();

// Item 7: Require valid user authentication and verify auth token on all /api/v1/rooms/* routes
router.use(requireUser);

// Room Management Routes
router.post('/', roomController.createRoom);
router.post('/join', roomController.joinRoom);
router.post('/leave', roomController.leaveRoom);
router.get('/:id', roomController.getRoom);
router.get('/:id/strokes', roomController.getRoomStrokes);

export default router;
