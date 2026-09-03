import { NextResponse } from 'next/server';
import { TransactionEngine } from '@/commerce/transaction-engine';
import { pushLiveTransaction } from '@/services/live-transaction-store';

/**
 * POST /api/agentic/checkout
 *
 * The unified checkout endpoint for AI commerce transactions.
 *
 * Actions:
 *   - INITIATE: Create a real order + Razorpay order + transaction
 *   - VERIFY:   Handle payment callback after Razorpay checkout
 *   - TIMEOUT:  Simulate payment verification timeout
 *   - RETRY:    Retry verification for a timed-out transaction
 *   - TIMELINE: Get the audit timeline for an order
 */
export async function POST(req: Request) {
  let bodyForErrorTracking: Record<string, unknown> = {};
  try {
    const body = await req.json().catch(() => ({}));
    bodyForErrorTracking = body;
    const {
      action = 'INITIATE',
      // INITIATE params
      buyerAgentId = 'ai_buyer_demo',
      merchantId = 'merchant_001',
      productId = 'prod_003',
      quantity = 1,
      discountPaise = 0,
      upsellProductId,
      upsellQuantity = 1,
      // VERIFY params
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      // TIMEOUT / RETRY / TIMELINE params
      transactionId,
      orderId,
    } = body;

    if (action === 'INITIATE') {
      const result = await TransactionEngine.initiateTransaction({
        buyerAgentId,
        merchantId,
        productId,
        quantity,
        discountPaise,
        upsellProductId,
        upsellQuantity,
      });

      return NextResponse.json(
        {
          success: true,
          message: 'Transaction initiated — proceed to Razorpay payment.',
          ...result,
        },
        {
          headers: {
            'X-Agent-Commerce': 'Transaction-Initiated',
            'X-Policy-Gated': 'true',
          },
        }
      );
    }

    if (action === 'VERIFY') {
      if (!razorpayOrderId || !razorpayPaymentId) {
        return NextResponse.json(
          { success: false, error: 'razorpayOrderId and razorpayPaymentId required' },
          { status: 400 }
        );
      }

      const result = await TransactionEngine.handlePaymentCallback({
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature: razorpaySignature || '',
      });

      return NextResponse.json({
        success: true,
        message: 'Payment verified and order confirmed.',
        ...result,
      });
    }

    if (action === 'TIMEOUT') {
      if (!transactionId) {
        return NextResponse.json(
          { success: false, error: 'transactionId required' },
          { status: 400 }
        );
      }

      const result = await TransactionEngine.handleVerificationTimeout(transactionId);

      // Record timeout as a FAILED transaction
      pushLiveTransaction({
        id: `fail_timeout_${Date.now().toString(36)}`,
        type: 'FAILED',
        amountPaise: 0,
        razorpayOrderId: transactionId,
        productName: 'Payment Verification',
        buyerQuery: 'system',
        channel: 'RAZORPAY',
        errorReason: 'Payment verification timeout — fulfillment paused',
        timestamp: new Date().toISOString(),
      });

      return NextResponse.json({
        success: true,
        message: 'Payment verification timeout — fulfillment paused without duplicate charges.',
        ...result,
      });
    }

    if (action === 'RETRY') {
      if (!transactionId) {
        return NextResponse.json(
          { success: false, error: 'transactionId required' },
          { status: 400 }
        );
      }

      const result = await TransactionEngine.retryVerification(transactionId);
      return NextResponse.json({
        success: true,
        message: result.recovered
          ? 'Payment recovered and order confirmed.'
          : 'Payment still pending — will retry.',
        ...result,
      });
    }

    if (action === 'TIMELINE') {
      if (!orderId) {
        return NextResponse.json(
          { success: false, error: 'orderId required' },
          { status: 400 }
        );
      }

      const timeline = await TransactionEngine.getTransactionTimeline(orderId);
      return NextResponse.json({
        success: true,
        timeline,
      });
    }

    return NextResponse.json(
      { success: false, error: `Unknown action: ${action}` },
      { status: 400 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Agent checkout error';

    // Record FAILED transaction in live store so it appears on the dashboard
    pushLiveTransaction({
      id: `fail_${Date.now().toString(36)}`,
      type: 'FAILED',
      amountPaise: Number(bodyForErrorTracking.discountPaise || 0),
      razorpayOrderId: 'N/A',
      productName: String(bodyForErrorTracking.productId || 'Unknown'),
      buyerQuery: String(bodyForErrorTracking.buyerAgentId || 'ai_buyer'),
      channel: 'RAZORPAY',
      errorReason: message,
      timestamp: new Date().toISOString(),
    });

    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

