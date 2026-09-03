/**
 * CommerceOS AI Buyer
 *
 * AI Buyer agent using the Gemini API for intent extraction,
 * with DETERMINISTIC product filtering and ranking.
 *
 * LLM extracts intent and explains. Filtering/ranking/selection is deterministic code.
 */

import { CommerceDatabase, type CommerceProduct } from '@/commerce/commerce-db';

export interface BuyerIntent {
  category: string;
  budgetMaxPaise: number;
  requirements: string[];
  deliveryDeadline: string;
  occasion: string | null;
  giftableRequired: boolean;
}

export interface RankedCandidate {
  product: CommerceProduct;
  score: number;
  breakdown: {
    featureMatch: number;
    priceFit: number;
    delivery: number;
    inventory: number;
  };
}

export class AiBuyer {
  /**
   * Calls Gemini API to extract structured intent from natural language.
   * Falls back to simple keyword matching if API fails.
   */
  static async extractIntent(query: string): Promise<BuyerIntent> {
    const prompt = `You are an AI commerce buyer. Extract structured purchasing intent from this user query.

Return ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "category": "string (e.g. backpack, coffee, gift, travel, api, gear)",
  "budgetMaxPaise": number (convert rupees to paise, e.g. 5000 rupees = 500000 paise),
  "requirements": ["string array of specific features mentioned"],
  "deliveryDeadline": "string (e.g. tomorrow, 2 days, asap, standard)",
  "occasion": "string or null (e.g. birthday, business)",
  "giftableRequired": boolean
}

User query: "${query}"`;

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('GEMINI_API_KEY not set');

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        }
      );

      if (!response.ok) throw new Error(`Gemini API error: ${response.statusText}`);

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        const parsed = JSON.parse(text) as BuyerIntent;
        // Validate and sanitize
        return {
          category: parsed.category || 'general',
          budgetMaxPaise: parsed.budgetMaxPaise || 1000000,
          requirements: Array.isArray(parsed.requirements) ? parsed.requirements : [],
          deliveryDeadline: parsed.deliveryDeadline || 'standard',
          occasion: parsed.occasion || null,
          giftableRequired: Boolean(parsed.giftableRequired),
        };
      }
      throw new Error('Invalid Gemini response structure');
    } catch (error) {
      console.warn('[AiBuyer] Gemini fallback:', error);
      return this.fallbackExtractIntent(query);
    }
  }

  /** Keyword-based fallback when Gemini is unavailable */
  private static fallbackExtractIntent(query: string): BuyerIntent {
    const q = query.toLowerCase();

    // Budget extraction
    let budgetMaxPaise = 1000000; // default ₹10,000
    const priceMatch = q.match(/(?:under|budget|below)\s*(?:₹|rs\.?|inr)?\s*([\d,]+)/);
    if (priceMatch) {
      budgetMaxPaise = parseInt(priceMatch[1]!.replace(/,/g, ''), 10) * 100;
    }

    // Category
    let category = 'general';
    const categoryMap: Record<string, string[]> = {
      backpack: ['backpack', 'bag', 'rucksack'],
      coffee: ['coffee', 'brew', 'espresso'],
      gift: ['gift', 'present'],
      travel: ['travel', 'trip', 'commute'],
      api: ['api', 'tokens', 'credits', 'enterprise'],
    };
    for (const [cat, keywords] of Object.entries(categoryMap)) {
      if (keywords.some((kw) => q.includes(kw))) {
        category = cat;
        break;
      }
    }

    // Occasion
    let occasion: string | null = null;
    let giftableRequired = false;
    if (q.includes('birthday')) { occasion = 'birthday'; giftableRequired = true; }
    else if (q.includes('gift')) { occasion = 'gift'; giftableRequired = true; }

    // Requirements
    const requirements: string[] = [];
    const reqKeywords = ['waterproof', 'laptop', 'sleeve', 'leather', 'whole-bean', 'grinder'];
    for (const kw of reqKeywords) {
      if (q.includes(kw)) requirements.push(kw);
    }

    // Delivery
    let deliveryDeadline = 'standard';
    if (q.includes('tomorrow') || q.includes('urgent') || q.includes('today')) {
      deliveryDeadline = 'tomorrow';
    }

    return { category, budgetMaxPaise, requirements, deliveryDeadline, occasion, giftableRequired };
  }

  /**
   * DETERMINISTIC filtering against the catalog.
   */
  static async discoverProducts(intent: BuyerIntent): Promise<CommerceProduct[]> {
    const allProducts = await CommerceDatabase.getProducts();

    return allProducts.filter((product) => {
      // Price filter
      if (product.pricePaise > intent.budgetMaxPaise) return false;

      // Giftable filter
      if (intent.giftableRequired && !product.aiMetadata.giftable) return false;

      // Delivery filter
      const maxDays =
        intent.deliveryDeadline === 'tomorrow' || intent.deliveryDeadline === 'today' || intent.deliveryDeadline === 'urgent'
          ? 1
          : 7;
      if (product.aiMetadata.deliveryDays > maxDays) return false;

      // Category match (fuzzy)
      const intentCat = intent.category.toLowerCase();
      if (intentCat !== 'general') {
        const categoryMatch = product.category.toLowerCase().includes(intentCat);
        const useCaseMatch = product.aiMetadata.useCases.some((uc) =>
          uc.toLowerCase().includes(intentCat) || intentCat.includes(uc.toLowerCase())
        );
        if (!categoryMatch && !useCaseMatch) return false;
      }

      return true;
    });
  }

  /**
   * DETERMINISTIC scoring and ranking.
   *
   * score = featureMatch × 0.4 + priceFit × 0.3 + delivery × 0.2 + inventory × 0.1
   */
  static rankCandidates(products: CommerceProduct[], intent: BuyerIntent): RankedCandidate[] {
    const ranked = products.map((product) => {
      // Feature match
      const features = product.aiMetadata.features.map((f) => f.toLowerCase());
      let matchedReqs = 0;
      for (const req of intent.requirements) {
        if (features.some((f) => f.includes(req.toLowerCase()))) matchedReqs++;
      }
      const featureMatch = intent.requirements.length > 0 ? matchedReqs / intent.requirements.length : 1.0;

      // Price fit
      const priceFit = Math.max(0, Math.min(1, 1.0 - product.pricePaise / intent.budgetMaxPaise));

      // Delivery
      const maxDays = intent.deliveryDeadline === 'tomorrow' || intent.deliveryDeadline === 'urgent' ? 1 : 7;
      let delivery = 0;
      if (product.aiMetadata.deliveryDays <= maxDays) delivery = 1.0;
      else if (product.aiMetadata.deliveryDays === maxDays + 1) delivery = 0.5;

      // Inventory
      const inventory = Math.min(1.0, product.inventory / 20);

      const score = featureMatch * 0.4 + priceFit * 0.3 + delivery * 0.2 + inventory * 0.1;

      return {
        product,
        score: Math.round(score * 100) / 100,
        breakdown: { featureMatch, priceFit, delivery, inventory },
      };
    });

    return ranked.sort((a, b) => b.score - a.score);
  }

  /**
   * Selects the top candidate and uses Gemini to explain.
   */
  static async selectAndExplain(
    candidates: RankedCandidate[],
    intent: BuyerIntent
  ): Promise<{ selectedProduct: CommerceProduct | null; explanation: string }> {
    if (candidates.length === 0) {
      return { selectedProduct: null, explanation: 'No products matched your criteria.' };
    }

    const top = candidates[0]!;
    const selectedProduct = top.product;

    let explanation = '';
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('No key');

      const prompt = `You are an AI commerce buyer. You selected "${selectedProduct.name}" (₹${(selectedProduct.pricePaise / 100).toLocaleString('en-IN')}) for a user who said: "${intent.category}" with budget ₹${(intent.budgetMaxPaise / 100).toLocaleString('en-IN')}, occasion: ${intent.occasion || 'none'}.

Write a 2-3 sentence explanation of why this product was selected. Be specific about features and value.`;

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );

      if (res.ok) {
        const data = await res.json();
        explanation = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      }
    } catch {
      // Fallback
    }

    if (!explanation) {
      explanation = `Selected "${selectedProduct.name}" — best match for your ${intent.category} needs within ₹${(intent.budgetMaxPaise / 100).toLocaleString('en-IN')} budget. Score: ${(top.score * 100).toFixed(0)}% match based on features, price, and delivery.`;
    }

    // Record audit event
    await CommerceDatabase.recordAuditEvent({
      actor: 'AI_BUYER',
      action: 'PRODUCT_SELECTED',
      input: {
        intent,
        candidateCount: candidates.length,
        topScore: top.score,
      },
      decision: {
        selectedProductId: selectedProduct.id,
        selectedProductName: selectedProduct.name,
        pricePaise: selectedProduct.pricePaise,
      },
      reason: explanation,
      policySnapshot: {},
      result: 'APPROVED',
    });

    return { selectedProduct, explanation };
  }

  /**
   * Full discovery pipeline orchestrator.
   */
  static async runFullDiscovery(query: string) {
    const intent = await this.extractIntent(query);
    const discovered = await this.discoverProducts(intent);
    const candidates = this.rankCandidates(discovered, intent);
    const { selectedProduct, explanation } = await this.selectAndExplain(candidates, intent);

    return { intent, candidates, selectedProduct, explanation };
  }
}
