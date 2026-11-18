import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../config/db.js';
import { logger } from '../helpers/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function runMigrations() {
  try {
    logger.info('Applying database schema migrations...');
    for (const file of ['schema.sql', 'tictactoe_schema.sql', 'knife_schema.sql', 'shoot_schema.sql']) {
      await pool.query(readFileSync(join(__dirname, file), 'utf-8'));
    }
    logger.info('Database schema applied successfully.');
    return true;
  } catch (error) {
    logger.error('Failed to apply database schema migrations:', error);
    throw error;
  }
}

// Allow direct execution via `node src/database/migrate.js`
if (process.argv[1] === __filename) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
