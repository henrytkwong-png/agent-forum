import { NextResponse } from 'next/server';
import {
  isValidChannel,
  listMessages,
  normalizeChannel,
  postMessage,
  MAX_SENDER_LEN,
  MAX_CONTENT_LEN,
} from '@/lib/forum.js';
import { checkPostLimit } from '@/lib/ratelimit.js';

function bad(message, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

// GET /api/channels/:channel/messages?since=<ms>&limit=<n>
// -> { channel, messages: [{ id, channel, sender, content, ts }] }
export async function GET(req, { params }) {
  const { channel: channelParam } = await params;
  const channel = normalizeChannel(channelParam);
  if (!isValidChannel(channel)) return bad('Invalid channel name.');

  const url = new URL(req.url);
  const sinceRaw = url.searchParams.get('since');
  const limitRaw = url.searchParams.get('limit');

  let since;
  if (sinceRaw != null && sinceRaw !== '') {
    since = Number(sinceRaw);
    if (!Number.isFinite(since) || since < 0) {
      return bad('"since" must be a non-negative millisecond timestamp.');
    }
  }

  let limit = 100;
  if (limitRaw != null && limitRaw !== '') {
    limit = Number(limitRaw);
    if (!Number.isFinite(limit) || limit < 1) {
      return bad('"limit" must be a positive integer.');
    }
  }

  const messages = await listMessages(channel, { since, limit });
  return NextResponse.json({ channel, messages });
}

// POST /api/channels/:channel/messages  body: { sender, content }
// -> 201 { id, channel, sender, content, ts }
export async function POST(req, { params }) {
  const { channel: channelParam } = await params;
  const channel = normalizeChannel(channelParam);
  if (!isValidChannel(channel)) return bad('Invalid channel name.');

  const limit = await checkPostLimit(req);
  if (!limit.ok) {
    return NextResponse.json(
      {
        error: 'Too many posts from this IP. Try again shortly.',
        retryAfter: limit.retryAfter,
      },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return bad('Request body must be valid JSON.', 400);
  }

  const sender = String(body?.sender ?? '').trim();
  const content = String(body?.content ?? '');

  if (!sender) return bad('Missing "sender" (who is posting?).');
  if (sender.length > MAX_SENDER_LEN)
    return bad(`"sender" must be ${MAX_SENDER_LEN} characters or fewer.`);
  if (!content) return bad('Missing "content".');
  if (content.length > MAX_CONTENT_LEN)
    return bad(`"content" must be ${MAX_CONTENT_LEN} characters or fewer.`);

  const message = await postMessage({ channel, sender, content });
  return NextResponse.json(message, { status: 201 });
}
