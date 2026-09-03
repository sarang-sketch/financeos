import { NextResponse } from 'next/server';
import { AgenticCommerceService } from '@/services/agentic-commerce-service';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { action = 'SINGLE', sessionId, channel = 'WHATSAPP' } = body;

    if (action === 'AUTO_ALL') {
      const result = AgenticCommerceService.autoNudgeAllHighIntent();
      return NextResponse.json({ success: true, result });
    }

    if (!sessionId) {
      return NextResponse.json({ success: false, error: 'sessionId is required' }, { status: 400 });
    }

    const result = AgenticCommerceService.dispatchBuyerNudge(sessionId, channel);
    return NextResponse.json({ success: true, result });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || 'Nudge dispatch error' }, { status: 500 });
  }
}
