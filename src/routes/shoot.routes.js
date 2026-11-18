import { Router } from 'express';
import { shootController } from '../controllers/shoot.controller.js';
import { requireUser } from '../middlewares/auth.middleware.js';

const router = Router();

router.post('/', requireUser, shootController.createGame);
router.post('/join', requireUser, shootController.joinGame);
router.get('/code/:code', shootController.getGameByCode);
router.get('/:id', shootController.getGame);

export default router;

