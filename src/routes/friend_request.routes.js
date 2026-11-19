import { Router } from 'express';
import { friendRequestController } from '../controllers/friend_request.controller.js';
import { requireUser } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(requireUser);

router.post('/', friendRequestController.sendRequest);
router.get('/', friendRequestController.listRequests);
router.post('/:request_id/accept', friendRequestController.acceptRequest);
router.post('/:request_id/decline', friendRequestController.declineRequest);
router.delete('/:request_id', friendRequestController.cancelRequest);

export default router;

