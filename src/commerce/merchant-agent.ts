import { CommerceDatabase, CommerceProduct } from '@/commerce/commerce-db';
import { MoneyFirewall, EvaluationResult } from '@/commerce/money-firewall';

export interface BuyerIntent {
  intent: string;
  budget: number;
  requirements?: string[];
}

export interface GenerateOfferParams {
  productId: string;
  buyerIntent: BuyerIntent;
  requestedDiscountPercent?: number;
}

export interface UpsellCandidate {
  product: CommerceProduct;
  score: number;
  reasons: string[];
}

export interface OfferResult {
  product: CommerceProduct;
  basePricePaise: number;
  discountedPricePaise: number;
  discountPercent: number;
  upsell: UpsellCandidate | null;
  totalPaise: number;
  firewallResult: EvaluationResult;
  reasons: string[];
  auditDigest: string;
}

export class MerchantAgent {
  /**
   * Generates scored upsell candidates for a given product and buyer intent.
   */
  static async getUpsellCandidates(productId: string, buyerIntent: BuyerIntent): Promise<UpsellCandidate[]> {
    const products = await CommerceDatabase.getProducts({ category: 'Addons' });
    const candidates: UpsellCandidate[] = [];

    const intentKeywords = buyerIntent.intent.toLowerCase().split(/\s+/);

    for (const addon of products) {
      // intentMatch: 1.0 if product.aiMetadata.useCases overlaps with buyer intent keywords, 0.5 otherwise
      let intentMatch = 0.5;
      const hasOverlap = addon.aiMetadata.useCases.some((uc) =>
        intentKeywords.some((k) => uc.toLowerCase().includes(k) || k.includes(uc.toLowerCase()))
      );
      if (hasOverlap) {
        intentMatch = 1.0;
      }

      // attachRate: hardcoded per-product
      let attachRate = 0.1;
      const lowerName = addon.name.toLowerCase();
      if (lowerName.includes('gift') && lowerName.includes('wrap')) {
        attachRate = 0.65;
      } else if (lowerName.includes('battery') || lowerName.includes('charger')) {
        attachRate = 0.78;
      } else if (lowerName.includes('guarantee') || lowerName.includes('care') || lowerName.includes('warranty')) {
        attachRate = 0.35;
      }

      // marginFactor: product.marginPercent / 100
      const marginFactor = addon.marginPercent / 100;

      // inventoryFactor: min(1.0, product.inventory / 50)
      const inventoryFactor = Math.min(1.0, addon.inventory / 50);

      const score = intentMatch * attachRate * marginFactor * inventoryFactor;

      const reasons: string[] = [];
      if (intentMatch === 1.0) reasons.push(`Strong overlap with buyer intent: '${buyerIntent.intent}'`);
      if (attachRate >= 0.28) reasons.push('High historical attach rate');
      if (marginFactor > 0.5) reasons.push('Healthy margin profile allows bundling');

      candidates.push({ product: addon, score, reasons });
    }

    return candidates.sort((a, b) => b.score - a.score);
  }

  /**
   * Generates a contextual offer with deterministic upsell scoring and firewall checks.
   */
  static async generateOffer(params: GenerateOfferParams): Promise<OfferResult> {
    const { productId, buyerIntent, requestedDiscountPercent = 0 } = params;

    // 1. Fetch product
    const product = await CommerceDatabase.getProductById(productId);
    if (!product) {
      throw new Error(`Product not found: ${productId}`);
    }

    // 2. Fetch policy
    const policy = await CommerceDatabase.getMerchantPolicy(product.merchantId);

    // 3. Calculate effective discount
    const effectiveDiscount = Math.min(requestedDiscountPercent, policy.maxDiscountPercent);

    // 4. Run through MoneyFirewall for the discount
    const firewallResult = await MoneyFirewall.evaluateAction({
      action: 'DISCOUNT',
      merchantId: product.merchantId,
      amountPaise: product.pricePaise,
      requestedDiscountPercent: requestedDiscountPercent, // Send original to let firewall decide if it's allowed
      productMarginPercent: product.marginPercent,
    });

    // 5 & 6. Select contextual upsell using deterministic scoring
    const candidates = await this.getUpsellCandidates(productId, buyerIntent);
    const topUpsell = candidates.length > 0 ? candidates[0] : null;

    // 7. Calculate totals
    const finalDiscountPercent = firewallResult.allowed
      ? firewallResult.requestedDiscountPercent
      : (firewallResult.counterOfferDiscountPercent ?? effectiveDiscount);
      
    const discountedPricePaise = Math.floor(product.pricePaise * (1 - finalDiscountPercent / 100));
    const upsellPaise = topUpsell ? topUpsell.product.pricePaise : 0;
    const totalPaise = discountedPricePaise + upsellPaise;

    // 8. Generate reasons array
    const reasons = ['Evaluated offer using deterministic policy rules.'];
    if (topUpsell) {
      reasons.push(`Selected upsell '${topUpsell.product.name}' (score: ${topUpsell.score.toFixed(3)}).`);
    }
    if (!firewallResult.allowed) {
      reasons.push(`Requested discount ${requestedDiscountPercent}% was blocked; offering counter of ${finalDiscountPercent}%.`);
    }

    // 9. Record audit event
    const auditEvent = await CommerceDatabase.recordAuditEvent({
      actor: 'MERCHANT_AGENT',
      action: 'CREATE_OFFER',
      input: { productId, buyerIntent, requestedDiscountPercent },
      decision: { finalDiscountPercent, topUpsellId: topUpsell?.product.id },
      reason: reasons.join(' '),
      policySnapshot: policy as unknown as Record<string, unknown>,
      result: 'APPROVED', // The offer generation itself is successful
    });

    // 10. Return the offer
    return {
      product,
      basePricePaise: product.pricePaise,
      discountedPricePaise,
      discountPercent: finalDiscountPercent,
      upsell: topUpsell ?? null,
      totalPaise,
      firewallResult,
      reasons,
      auditDigest: auditEvent.sha256Digest,
    };
  }
}
