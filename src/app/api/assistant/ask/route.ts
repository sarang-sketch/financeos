import { NextResponse } from 'next/server';
import { GroqAssistantService } from '@/services/groq-assistant-service';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const question = body.question || 'Why did payment pay_fail_901 fail?';
    const tenantId = req.headers.get('x-tenant-id') || undefined;

    const assistant = new GroqAssistantService(tenantId);
    const response = await assistant.answerQuestion(question);

    return NextResponse.json(response);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
