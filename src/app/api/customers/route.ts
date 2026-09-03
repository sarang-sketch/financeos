import { NextResponse } from 'next/server';
import { RecoveryDataService } from '@/services/recovery-data-service';

export async function GET(req: Request) {
  try {
    const tenantId = req.headers.get('x-tenant-id') || undefined;
    const service = new RecoveryDataService(tenantId);
    const customers = await service.getCustomers();
    return NextResponse.json({ customers, count: customers.length });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
