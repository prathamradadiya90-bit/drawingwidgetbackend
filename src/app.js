import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { apiRouter } from './routes/index.js';
import { notFoundHandler, errorHandler } from './middlewares/error.middleware.js';
import { pool } from './config/db.js';

const app = express();

// Standard middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Lightweight Ping (instant wake up, 0 DB query overhead)
app.get('/ping', (req, res) => res.status(200).send('pong'));
app.get('/api/v1/ping', (req, res) => res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() }));

// Health Check (verifies DB connectivity)
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  try {
    await pool.query('SELECT 1');
    dbStatus = 'connected';
  } catch (err) {
    dbStatus = 'error';
  }

  res.status(200).json({
    status: 'ok',
    database: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.use('/api', apiRouter);

// Fallback 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

export default app;
