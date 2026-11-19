import { notificationService } from '../services/notification.service.js';
import { successResponse, errorResponse } from '../helpers/response.helper.js';

export const notificationController = {
  // GET /notifications
  async listNotifications(req, res, next) {
    try {
      const notifications = await notificationService.listNotifications({
        userId: req.userId,
      });
      return successResponse(res, { notifications }, 'OK', 200);
    } catch (err) {
      next(err);
    }
  },

  // POST /notifications/ack
  async acknowledge(req, res, next) {
    try {
      const { notification_ids, all } = req.body || {};
      const io = req.app.get('io');

      const data = await notificationService.acknowledgeNotifications({
        userId: req.userId,
        notificationIds: notification_ids,
        all,
        io,
      });
      return successResponse(res, data, 'OK', 200);
    } catch (err) {
      next(err);
    }
  },
};

