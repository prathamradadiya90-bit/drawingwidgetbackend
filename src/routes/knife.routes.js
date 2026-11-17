import { Router } from 'express';
import { knifeController } from '../controllers/knife.controller.js';
import { requireUser } from '../middlewares/auth.middleware.js';

const router = Router();

router.post('/', requireUser, knifeController.createGame);
router.post('/join', requireUser, knifeController.joinGame);
router.get('/code/:code', knifeController.getGameByCode);
router.get('/:id', knifeController.getGame);

export default router;

