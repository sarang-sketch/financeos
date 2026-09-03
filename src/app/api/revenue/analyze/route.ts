import { NextResponse } from 'next/server';
import { RevenueAgent } from '@/commerce/revenue-agent';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, merchantId = 'M-1234', strategyId } = body;

    switch (action) {
      case 'SIMULATE':
        if (!strategyId) {
          return NextResponse.json({ error: 'Missing strategyId' }, { status: 400 });
        }
        const simulation = await RevenueAgent.simulateStrategy(strategyId, merchantId);
        return NextResponse.json(simulation);

      case 'APPROVE':
        if (!strategyId) {
          return NextResponse.json({ error: 'Missing strategyId' }, { status: 400 });
        }
        const approval = await RevenueAgent.approveStrategy(strategyId, merchantId);
        return NextResponse.json(approval);

      case 'EXECUTE':
        if (!strategyId) {
          return NextResponse.json({ error: 'Missing strategyId' }, { status: 400 });
        }
        const execution = await RevenueAgent.executeStrategy(strategyId, merchantId);
        return NextResponse.json(execution);

      default:
        // Default action: Analyze and generate revenue plan
        const plan = await RevenueAgent.getRevenuePlan(merchantId);
        return NextResponse.json(plan);
    }
  } catch (error: any) {
    console.error('Revenue Agent Error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error.message },
      { status: 500 }
    );
  }
}
