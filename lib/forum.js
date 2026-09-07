// lib/forum.js
// ------------------------------------------------------------------
// Core forum operations on top of the storage wrapper.
//
// Data model (Vercel KV / Redis):
//   channels            SET  of channel names
//   msgs:<channel>      ZSET member = message id, score = ts (ms)
//   msg:<id>            JSON  { id, channel, sender, content, ts }
// ------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import * as kv from './kv.js';

const CHANNEL_KEY = 'channels';
const msgIndexKey = (channel) => `msgs:${channel}`;
const msgKey = (id) => `msg:${id}`;

// Keep at most this many messages per channel (oldest dropped).
const MAX_MESSAGES_PER_CHANNEL = 2000;

export const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
export const MAX_SENDER_LEN = 120;
export const MAX_CONTENT_LEN = 8000;

export function normalizeChannel(name) {
  return String(name || '').trim().toLowerCase();
}

export function isValidChannel(name) {
  return CHANNEL_RE.test(name);
}

export async function listChannels() {
  const names = await kv.smembers(CHANNEL_KEY);
  const channels = await Promise.all(
    names.map(async (name) => {
      const lastIds = await kv.zrange(msgIndexKey(name), -1, -1);
      let last = null;
      if (lastIds.length) {
        const msg = await kv.get(msgKey(lastIds[0]));
        if (msg) {
          last = {
            ts: msg.ts,
            sender: msg.sender,
            preview: (msg.content || '').slice(0, 80),
          };
        }
      }
      return { name, last };
    })
  );
  // Most recently active first; empty channels at the end, alphabetical.
  channels.sort((a, b) => {
    const ta = a.last ? a.last.ts : -Infinity;
    const tb = b.last ? b.last.ts : -Infinity;
    if (ta !== tb) return tb - ta;
    return a.name < b.name ? -1 : 1;
  });
  return channels;
}

export async function createChannel(name) {
  const clean = normalizeChannel(name);
  if (!isValidChannel(clean)) {
    const err = new Error(
      'Invalid channel name: use 1-64 chars of a-z, 0-9, "_" or "-" (letters/digits first).'
    );
    err.status = 400;
    throw err;
  }
  const added = await kv.sadd(CHANNEL_KEY, clean);
  return { channel: clean, created: added === 1 };
}

export async function postMessage({ channel, sender, content }) {
  const id = randomUUID();
  const ts = Date.now();
  const msg = { id, channel, sender, content, ts };

  const indexKey = msgIndexKey(channel);
  await kv.zadd(indexKey, id, ts);
  await kv.set(msgKey(id), msg);
  await kv.sadd(CHANNEL_KEY, channel);

  // Trim the channel to the most recent MAX_MESSAGES_PER_CHANNEL.
  const total = await kv.zcard(indexKey);
  if (total > MAX_MESSAGES_PER_CHANNEL) {
    await kv.zremrangebyrank(indexKey, 0, total - MAX_MESSAGES_PER_CHANNEL - 1);
  }

  return msg;
}

/**
 * Fetch messages for a channel, ascending by time.
 *
 * @param {string} channel  normalized channel name
 * @param {object} [opts]
 * @param {number} [opts.since] only messages with ts > since
 * @param {number} [opts.limit] max messages to return (default 100, max 500)
 */
export async function listMessages(channel, { since, limit = 100 } = {}) {
  const capped = Math.min(Math.max(1, limit), 500);
  const indexKey = msgIndexKey(channel);

  let ids;
  if (typeof since === 'number' && Number.isFinite(since) && since > 0) {
    ids = await kv.zrangebyscore(indexKey, since + 1, '+inf', {
      offset: 0,
      count: capped,
    });
  } else {
    // Most recent `capped` messages, returned ascending.
    ids = await kv.zrange(indexKey, -capped, -1);
  }

  if (!ids.length) return [];

  const msgs = await Promise.all(ids.map((id) => kv.get(msgKey(id))));
  return msgs
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts)
    .slice(-capped);
}

export async function getMessageCount(channel) {
  return kv.zcard(msgIndexKey(channel));
}
