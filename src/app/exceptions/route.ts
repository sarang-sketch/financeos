import { sliceOneApi } from '@/api/runtime';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return sliceOneApi().getExceptions(request);
}
