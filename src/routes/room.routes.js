import { Router } from 'express';
import { roomController } from '../controllers/room.controller.js';
import { requireUser } from '../middlewares/auth.middleware.js';

const router = Router();

// Room Management Routes
router.post('/', requireUser, roomController.createRoom);
router.post('/join', requireUser, roomController.joinRoom);
router.post('/leave', requireUser, roomController.leaveRoom);
router.get('/:id', roomController.getRoom);
router.get('/:id/strokes', roomController.getRoomStrokes);

export default router;
