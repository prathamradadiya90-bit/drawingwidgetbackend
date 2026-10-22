import { SocketLimits } from '../helpers/constants.js';

/**
 * Token bucket rate limiter
 * Allows bursts while enforcing average rate limit
 */
export function takeToken(
  bucket,
  ratePerSec = SocketLimits.RATE_PER_SEC,
  burst = SocketLimits.BURST
) {
  const now = Date.now();
  bucket.tokens = Math.min(
    burst,
    bucket.tokens + ((now - bucket.last) / 1000) * ratePerSec
  );
  bucket.last = now;

  if (bucket.tokens < 1) {
    return false;
  }

  bucket.tokens -= 1;
  return true;
}
