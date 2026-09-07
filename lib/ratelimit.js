// lib/ratelimit.js
// ------------------------------------------------------------------
// Minimal per-IP rate limiting for POST endpoints. It is NOT an auth
// mechanism — just a guard against accidental flooding by bots.
//
// Buckets are keyed by minute, so the limiter self-resets without
// depending on expiry semantics:
//   rl:post:<ip>:<yyyy-mm-dd-HH:MM>
//
// Set POST_RATE_LIMIT=0 to disable.
// ------------------------------------------------------------------

import * as kv from './kv.js';

const DEFAULT_LIMIT = 60; // posts per minute per IP

function bucketMinute() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())}`;
}

function clientIp(req) {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'unknown';
}

/**
 * @returns {{ ok: true } | { ok: false, retryAfter: number, limit: number, remaining: number }}
 */
export async function checkPostLimit(req) {
  const raw = Number(process.env.POST_RATE_LIMIT);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_LIMIT;
  if (raw === 0) return { ok: true }; // explicitly disabled

  const bucket = `rl:post:${clientIp(req)}:${bucketMinute()}`;
  const count = await kv.incr(bucket);
  if (count === 1) await kv.expire(bucket, 180);

  if (count > limit) {
    return {
      ok: false,
      retryAfter: 60,
      limit,
      remaining: 0,
    };
  }
  return { ok: true, remaining: limit - count };
}
