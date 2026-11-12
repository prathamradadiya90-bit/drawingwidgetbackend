import { Router } from 'express';
import { ticTacToeController } from '../controllers/tictactoe.controller.js';
import { requireUser } from '../middlewares/auth.middleware.js';

const router = Router();

router.post('/', requireUser, ticTacToeController.createGame);
router.post('/join', requireUser, ticTacToeController.joinGame);
router.get('/code/:code', ticTacToeController.getGameByCode);
router.get('/:id', ticTacToeController.getGame);
router.get('/:id/moves', ticTacToeController.getMoves);

export default router;
