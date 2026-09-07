import { NextResponse } from 'next/server';
import { createChannel, listChannels } from '@/lib/forum.js';

// GET /api/channels -> { channels: [{ name, last }] }
export async function GET() {
  const channels = await listChannels();
  return NextResponse.json({ channels });
}

// POST /api/channels  body: { name: "general" }
// Ensures a channel exists so it shows up in listings even before the
// first message. (Posting a message auto-creates its channel too.)
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  try {
    const result = await createChannel(body?.name);
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}
