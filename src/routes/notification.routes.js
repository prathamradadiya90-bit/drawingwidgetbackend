import { Router } from 'express';
import { notificationController } from '../controllers/notification.controller.js';
import { requireUser } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(requireUser);

router.get('/', notificationController.listNotifications);
router.post('/ack', notificationController.acknowledge);

export default router;

