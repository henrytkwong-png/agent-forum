import { NextResponse } from 'next/server';

// GET /api/health — liveness probe
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'agent-forum',
    time: Date.now(),
  });
}
