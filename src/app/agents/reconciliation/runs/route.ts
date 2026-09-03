import { sliceOneApi } from '@/api/runtime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return sliceOneApi().postReconciliationRun(request);
}
