import { errorResponse } from '../helpers/response.helper.js';

export const notFoundHandler = (req, res) => {
  return errorResponse(res, `Cannot ${req.method} ${req.originalUrl}`, 404);
};

export const errorHandler = (err, req, res, next) => {
  console.error(err);
  const statusCode = err.statusCode || 500;
  const message = err.message || 'An unexpected error occurred';
  return errorResponse(res, message, statusCode, process.env.NODE_ENV === 'development' ? err.stack : null);
};
