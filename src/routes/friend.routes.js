import { Router } from 'express';
import { friendController } from '../controllers/friend.controller.js';
import { requireUser } from '../middlewares/auth.middleware.js';

const router = Router();

router.get('/', requireUser, friendController.list);
router.post('/', requireUser, friendController.add);
router.delete('/:user_id', requireUser, friendController.remove);

export default router;
