import { sliceOneApi } from '@/api/runtime';

export const dynamic = 'force-dynamic';

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  return sliceOneApi().getEvidenceChain(request, id);
}
