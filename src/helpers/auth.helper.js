import crypto from 'node:crypto';

/**
 * Generate a cryptographically secure random device token.
 * Minimum 32 bytes, encoded as base64url.
 */
export function generateDeviceToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Compute SHA-256 hash of a device token (hex-encoded).
 */
export function hashDeviceToken(token) {
  if (!token || typeof token !== 'string') return null;
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

/**
 * Constant-time comparison between a candidate token and stored SHA-256 hash.
 */
export function verifyDeviceToken(token, storedHash) {
  if (!token || !storedHash || typeof token !== 'string' || typeof storedHash !== 'string') {
    return false;
  }
  const candidateHash = hashDeviceToken(token);
  if (!candidateHash) return false;

  const candidateBuf = Buffer.from(candidateHash, 'hex');
  const storedBuf = Buffer.from(storedHash.trim(), 'hex');

  if (candidateBuf.length !== storedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(candidateBuf, storedBuf);
}
