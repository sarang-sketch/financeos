import { NextResponse } from 'next/server';
import { TransactionEngine } from '@/commerce/transaction-engine';

/**
 * POST /api/webhooks/razorpay
 *
 * Razorpay webhook handler for commerce payment verification.
 * Handles the `payment.captured` event from Razorpay.
 *
 * In test mode, also accepts direct verification calls from the frontend
 * after Razorpay Checkout.js completes.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));

    // Handle Razorpay webhook event format
    const event = body.event as string | undefined;
    let razorpayOrderId: string;
    let razorpayPaymentId: string;
    let razorpaySignature: string;

    if (event === 'payment.captured' && body.payload?.payment?.entity) {
      // Razorpay webhook format
      const payment = body.payload.payment.entity;
      razorpayOrderId = payment.order_id;
      razorpayPaymentId = payment.id;
      razorpaySignature = req.headers.get('x-razorpay-signature') || '';
    } else {
      // Direct verification call from frontend
      razorpayOrderId = body.razorpay_order_id || body.razorpayOrderId || '';
      razorpayPaymentId = body.razorpay_payment_id || body.razorpayPaymentId || '';
      razorpaySignature = body.razorpay_signature || body.razorpaySignature || '';
    }

    if (!razorpayOrderId || !razorpayPaymentId) {
      return NextResponse.json(
        { ok: false, error: 'Missing razorpay_order_id or razorpay_payment_id' },
        { status: 400 }
      );
    }

    const result = await TransactionEngine.handlePaymentCallback({
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });

    return NextResponse.json({
      ok: true,
      event_id: result.auditEventId,
      status: 'VERIFIED',
      order_id: result.orderId,
      order_status: result.orderStatus,
      transaction_id: result.transactionId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Webhook processing error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
