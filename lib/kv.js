// lib/kv.js
// ------------------------------------------------------------------
// Thin storage wrapper.
//
// When a Redis REST endpoint is configured we use the @upstash/redis
// client (Upstash Redis over HTTP — the modern Vercel "Redis" storage
// integration, and the legacy "KV" integration both work). Otherwise
// we fall back to an in-memory implementation so `npm run dev` works
// out of the box without provisioning a store (data lost on restart).
//
// Supported env vars:
//   UPSTASH_REDIS_REST_URL / _TOKEN         (Vercel Marketplace Redis, new)
//   KV_REST_API_URL / KV_REST_API_TOKEN      (legacy Vercel KV)
//
// Only the small subset of commands used by the app is exposed here,
// so if the SDK surface ever changes we adapt in one place.
// ------------------------------------------------------------------

import { Redis } from '@upstash/redis';

function buildClient() {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    return Redis.fromEnv();
  }
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
  return null;
}

// The client is safe to construct without network access; env is fixed
// for the lifetime of a serverless instance, so build it once up front.
const client = buildClient();

export const usingRemoteKV = Boolean(client);

// ---------- Sorted-set helpers used to back each channel ----------

export async function zadd(key, member, score) {
  if (client) return client.zadd(key, { score, member });
  return mock.zadd(key, member, score);
}

export async function zrange(key, start, stop) {
  if (client) return client.zrange(key, start, stop);
  return mock.zrange(key, start, stop);
}

// "messages newer than X" query, ascending by score.
export async function zrangebyscore(key, min, max, { offset = 0, count = 100 } = {}) {
  if (client) {
    return client.zrange(key, min, max, { byScore: true, offset, count });
  }
  return mock.zrangebyscore(key, min, max, { offset, count });
}

export async function zcard(key) {
  if (client) return client.zcard(key);
  return mock.zcard(key);
}

export async function zremrangebyrank(key, start, stop) {
  if (client) return client.zremrangebyrank(key, start, stop);
  return mock.zremrangebyrank(key, start, stop);
}

// ---------- Set helpers used to track channel names ----------

export async function sadd(key, member) {
  if (client) return client.sadd(key, member);
  return mock.sadd(key, member);
}

export async function smembers(key) {
  if (client) return client.smembers(key);
  return mock.smembers(key);
}

// ---------- String / counter helpers ----------

export async function set(key, value) {
  if (client) return client.set(key, value);
  return mock.set(key, value);
}

export async function get(key) {
  if (client) return client.get(key);
  return mock.get(key);
}

export async function incr(key) {
  if (client) return client.incr(key);
  return mock.incr(key);
}

export async function expire(key, seconds) {
  if (client) return client.expire(key, seconds);
  return mock.expire(key, seconds);
}

// ------------------------------------------------------------------
// In-memory fallback
// ------------------------------------------------------------------

// Keep the mock state on globalThis so Next dev's on-demand module
// recompilation does not silently wipe stored messages mid-session.
const g = globalThis;
if (!g.__agentForumMockState) {
  g.__agentForumMockState = { strings: new Map(), sets: new Map(), zsets: new Map() };
}
const state = g.__agentForumMockState;

const mock = {
  async sadd(key, member) {
    if (!state.sets.has(key)) state.sets.set(key, new Set());
    const set = state.sets.get(key);
    const was = set.has(member);
    set.add(member);
    return was ? 0 : 1;
  },
  async smembers(key) {
    return state.sets.has(key) ? [...state.sets.get(key)] : [];
  },

  async zadd(key, member, score) {
    if (!state.zsets.has(key)) state.zsets.set(key, new Map());
    state.zsets.get(key).set(member, score);
    return 1;
  },

  _zsorted(key) {
    const map = state.zsets.get(key) || new Map();
    return [...map.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  },

  async zcard(key) {
    return (state.zsets.get(key) || new Map()).size;
  },

  async zrange(key, start, stop) {
    const arr = this._zsorted(key);
    return applyIndexRange(arr.map((x) => x[0]), start, stop);
  },

  async zrangebyscore(key, min, max, { offset = 0, count = 100 } = {}) {
    const lo = min === '-inf' ? -Infinity : min === '+inf' ? Infinity : Number(min);
    const hi = max === '+inf' ? Infinity : max === '-inf' ? -Infinity : Number(max);
    const arr = this._zsorted(key)
      .filter(([, score]) => score >= lo && score <= hi)
      .map((x) => x[0]);
    return arr.slice(offset, offset + count);
  },

  async zremrangebyrank(key, start, stop) {
    const arr = this._zsorted(key).map((x) => x[0]);
    const ids = applyIndexRange(arr, start, stop);
    if (ids.length) {
      const map = state.zsets.get(key);
      for (const id of ids) map.delete(id);
    }
    return ids.length;
  },

  async set(key, value) {
    state.strings.set(key, value);
    return 'OK';
  },
  async get(key) {
    return state.strings.has(key) ? state.strings.get(key) : null;
  },

  async incr(key) {
    const next = ((state.strings.get(key) || 0) | 0) + 1;
    state.strings.set(key, next);
    return next;
  },
  async expire() {
    return 1; // no-op: callers key buckets by wall-clock minute anyway
  },
};

// Redis-style index normalization for zrange / zremrangebyrank
function applyIndexRange(arr, start, stop) {
  const n = arr.length;
  let s = start;
  let e = stop;
  if (s < 0) s = Math.max(0, n + s);
  if (e < 0) e = n + e;
  if (e >= n) e = n - 1;
  if (s > e || s >= n) return [];
  return arr.slice(s, e + 1);
}
