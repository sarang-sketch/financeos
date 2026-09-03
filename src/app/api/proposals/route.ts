import { NextResponse } from 'next/server';
import { RecoveryDataService } from '@/services/recovery-data-service';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status') || undefined;

    const tenantId = req.headers.get('x-tenant-id') || undefined;
    const service = new RecoveryDataService(tenantId);
    const proposals = await service.getProposals(status);
    return NextResponse.json({ proposals, count: proposals.length });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { proposalId, action } = body;

    if (!proposalId) {
      return NextResponse.json({ error: 'proposalId is required' }, { status: 400 });
    }

    const tenantId = req.headers.get('x-tenant-id') || undefined;
    const service = new RecoveryDataService(tenantId);

    if (action === 'approve' || action === 'execute') {
      const result = await service.approveAndExecute(proposalId);
      return NextResponse.json(result);
    }

    return NextResponse.json({ ok: true, status: 'UPDATED' });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
