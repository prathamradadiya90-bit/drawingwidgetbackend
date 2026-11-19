import { Router } from 'express';
import { userController } from '../controllers/user.controller.js';
import { requireUser } from '../middlewares/auth.middleware.js';

const router = Router();

router.post('/register', requireUser, userController.register);
router.post('/', requireUser, userController.register);
router.get('/by-code/:code', requireUser, userController.getByCode);

export default router;

