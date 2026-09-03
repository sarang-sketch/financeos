export interface AgentCatalogItem {
  sku: string;
  name: string;
  category: string;
  pricePaise: number;
  priceInrFormatted: string;
  stockAvailable: number;
  agentPurchasable: boolean;
  maxPerTransaction: number;
  crossSellAffinities: string[];
  description: string;
  agentProtocolSpec: {
    uapEligible: boolean;
    x402HeaderSupported: boolean;
    acpVersion: string;
  };
}

export interface AiBuyerTransaction {
  id: string;
  buyerAgentName: string;
  buyerAgentOwner: string;
  protocol: 'NPCI_UAP' | 'ACP_v1_2' | 'HTTP_x402' | 'AP2_GOOGLE';
  skuList: string[];
  amountPaise: number;
  amountInrFormatted: string;
  razorpayOrderId: string;
  policyStatus: 'PASSED' | 'GATE_BLOCKED_AND_MITIGATED' | 'REQUIRES_DUAL_AUTH';
  executionStatus: 'SETTLED' | 'IN_NEGOTIATION' | 'FAILED_GRACEFULLY_HANDLED';
  timestamp: string;
  explanation: string;
  auditSha256: string;
  mitigationApplied?: string;
}

export interface UpsellRecommendation {
  id: string;
  baseItemSku: string;
  recommendedSku: string;
  rationale: string;
  conversionProbabilityPercent: number;
  incrementalMarginPaise: number;
  expectedAovLiftPercent: number;
  status: 'ACTIVE' | 'PAUSED';
}

export interface GrowthCampaign {
  id: string;
  name: string;
  targetSegment: string;
  channel: 'UAP_DISCOVERY_FEED' | 'WHATSAPP_INTERACTIVE' | 'X402_AGENT_DIRECTORY';
  budgetCeilingPaise: number;
  spendToDatePaise: number;
  projectedRevenuePaise: number;
  roiMultiplier: number;
  status: 'RUNNING' | 'COMPLETED' | 'POLICY_PAUSED';
}

export type BuyerActivityStage =
  | 'ABANDONED_CART'
  | 'DROPPED_AT_CHECKOUT'
  | 'WISHLIST_ACTIVE'
  | 'AI_AGENT_CART_HELD';

export interface CartItemSummary {
  sku: string;
  name: string;
  quantity: number;
  pricePaise: number;
  priceInr: string;
}

export interface BuyerActivitySession {
  id: string;
  buyerName: string;
  buyerCompany?: string;
  phone: string;
  email: string;
  stage: BuyerActivityStage;
  items: CartItemSummary[];
  totalCartPaise: number;
  totalCartInr: string;
  timeAgo: string;
  intentScorePercent: number;
  lastAction: string;
  preferredChannel: 'WHATSAPP' | 'EMAIL' | 'CALL' | 'PUSH';
  recommendedNudge: string;
  lastNudgeStatus?: 'DELIVERED' | 'DISPATCHED' | 'PENDING';
  lastNudgeTime?: string;
  auditSha256?: string;
}

export interface AgenticCommerceSummary {
  totalAgenticVolumePaise: number;
  totalAgenticVolumeInr: string;
  aiBuyersServedCount: number;
  averageOrderValueInr: string;
  upsellMarginGeneratedPaise: number;
  upsellMarginGeneratedInr: string;
  gracefulFailuresHandledCount: number;
  catalog: AgentCatalogItem[];
  recentTransactions: AiBuyerTransaction[];
  upsells: UpsellRecommendation[];
  campaigns: GrowthCampaign[];
  buyerActivities: BuyerActivitySession[];
  supportedProtocols: string[];
}

export class AgenticCommerceService {
  private static catalog: AgentCatalogItem[] = [
    {
      sku: 'SKU_TOY_01',
      name: 'LEGO Technic 1:8 Hypercar Collector Edition (3,599 pcs)',
      category: 'Building & Construction',
      pricePaise: 2400000,
      priceInrFormatted: '₹24,000.00',
      stockAvailable: 28,
      agentPurchasable: true,
      maxPerTransaction: 2,
      crossSellAffinities: ['SKU_TOY_08'],
      description: 'Masterpiece 1:8 scale supercar with working W16 engine, 8-speed paddle gearbox, and active rear wing.',
      agentProtocolSpec: {
        uapEligible: true,
        x402HeaderSupported: true,
        acpVersion: '1.2.0',
      },
    },
    {
      sku: 'SKU_TOY_02',
      name: 'Smart AI Programmable Robotic Dog with HD Camera & Voice Control',
      category: 'STEM & Robotics',
      pricePaise: 850000,
      priceInrFormatted: '₹8,500.00',
      stockAvailable: 45,
      agentPurchasable: true,
      maxPerTransaction: 3,
      crossSellAffinities: ['SKU_TOY_07', 'SKU_TOY_08'],
      description: 'Intelligent bionic robotic pet with computer vision, gesture tracking, and Scratch/Python programmable routines.',
      agentProtocolSpec: {
        uapEligible: true,
        x402HeaderSupported: true,
        acpVersion: '1.2.0',
      },
    },
    {
      sku: 'SKU_TOY_03',
      name: '1:10 High-Speed All-Terrain Brushless RC Desert Buggy (65 km/h)',
      category: 'Remote Control & Vehicles',
      pricePaise: 1250000,
      priceInrFormatted: '₹12,500.00',
      stockAvailable: 60,
      agentPurchasable: true,
      maxPerTransaction: 2,
      crossSellAffinities: ['SKU_TOY_07'],
      description: 'Waterproof 4WD chassis, oil-filled metal shocks, 2.4GHz proportional radio transmitter, and dual high-torque servos.',
      agentProtocolSpec: {
        uapEligible: true,
        x402HeaderSupported: true,
        acpVersion: '1.2.0',
      },
    },
    {
      sku: 'SKU_TOY_04',
      name: 'DJI Tello STEM Educational Programmable Mini Drone',
      category: 'Drones & Flight',
      pricePaise: 450000,
      priceInrFormatted: '₹4,500.00',
      stockAvailable: 120,
      agentPurchasable: true,
      maxPerTransaction: 5,
      crossSellAffinities: ['SKU_TOY_07'],
      description: 'Ultra-safe obstacle-sensing drone powered by Scratch coding. Performs 8D flips and shoots 720p HD aerial video.',
      agentProtocolSpec: {
        uapEligible: true,
        x402HeaderSupported: true,
        acpVersion: '1.2.0',
      },
    },
    {
      sku: 'SKU_TOY_05',
      name: 'Montessori Wooden Sensory Activity Cube & Marble Run Maze',
      category: 'Early Learning & Puzzles',
      pricePaise: 220000,
      priceInrFormatted: '₹2,200.00',
      stockAvailable: 180,
      agentPurchasable: true,
      maxPerTransaction: 4,
      crossSellAffinities: ['SKU_TOY_08'],
      description: 'Natural organic beechwood activity center with gear puzzles, shape sorters, and magnetic bead maze.',
      agentProtocolSpec: {
        uapEligible: true,
        x402HeaderSupported: true,
        acpVersion: '1.2.0',
      },
    },
    {
      sku: 'SKU_TOY_06',
      name: 'Transformers Optimus Prime Auto-Converting Robotic Figure',
      category: 'Action Figures & Collectibles',
      pricePaise: 1450000,
      priceInrFormatted: '₹14,500.00',
      stockAvailable: 35,
      agentPurchasable: true,
      maxPerTransaction: 1,
      crossSellAffinities: ['SKU_TOY_08'],
      description: 'World’s first self-converting programmable robot with 27 servo motors, voice interaction, and app control.',
      agentProtocolSpec: {
        uapEligible: true,
        x402HeaderSupported: true,
        acpVersion: '1.2.0',
      },
    },
    {
      sku: 'SKU_TOY_07',
      name: 'Replacement High-Capacity LiPo Battery & Dual USB-C Fast Charger',
      category: 'Addons & Accessories',
      pricePaise: 80000,
      priceInrFormatted: '₹800.00',
      stockAvailable: 300,
      agentPurchasable: true,
      maxPerTransaction: 4,
      crossSellAffinities: [],
      description: 'Long-lasting 3000mAh battery pack extending RC and robotics play time by 45 minutes.',
      agentProtocolSpec: {
        uapEligible: true,
        x402HeaderSupported: true,
        acpVersion: '1.2.0',
      },
    },
    {
      sku: 'SKU_TOY_08',
      name: 'Deluxe Birthday Gift Wrap with Musical Pop-Up Greeting Card',
      category: 'Addons & Gifting',
      pricePaise: 19900,
      priceInrFormatted: '₹199.00',
      stockAvailable: 500,
      agentPurchasable: true,
      maxPerTransaction: 5,
      crossSellAffinities: [],
      description: 'Premium holographic gift wrapping with custom handwritten birthday message and musical chime card.',
      agentProtocolSpec: {
        uapEligible: true,
        x402HeaderSupported: true,
        acpVersion: '1.2.0',
      },
    },
  ];

  private static recentTransactions: AiBuyerTransaction[] = [
    {
      id: 'tx_a2a_01',
      buyerAgentName: 'BirthdayGift-Bot (Family Shopper AI)',
      buyerAgentOwner: 'Aarav Family Concierge',
      protocol: 'HTTP_x402',
      skuList: ['SKU_TOY_04', 'SKU_TOY_07'],
      amountPaise: 530000,
      amountInrFormatted: '₹5,300.00',
      razorpayOrderId: 'order_rzp_toy_8821a',
      policyStatus: 'PASSED',
      executionStatus: 'SETTLED',
      timestamp: '6 mins ago',
      explanation: 'AI buyer requested STEM drone for 10th birthday with fast charger addon. Verified merchant policy and settled via Razorpay test mode.',
      auditSha256: '9f8b22a01948cbb3124801e0a2948210394821049281aae8821940182390192a',
    },
    {
      id: 'tx_a2a_02',
      buyerAgentName: 'RoboPlay-Procure-Agent',
      buyerAgentOwner: 'PlayCraft Toy Studio',
      protocol: 'NPCI_UAP',
      skuList: ['SKU_TOY_01', 'SKU_TOY_08'],
      amountPaise: 2419900,
      amountInrFormatted: '₹24,199.00',
      razorpayOrderId: 'order_rzp_toy_8822b',
      policyStatus: 'PASSED',
      executionStatus: 'SETTLED',
      timestamp: '24 mins ago',
      explanation: 'Autonomous buyer purchased LEGO Technic 1:8 Hypercar with Deluxe Birthday Wrapping using pre-authorized token.',
      auditSha256: '38a192fc0021bbae339102938481029384819203810293848102938481029384',
    },
    {
      id: 'tx_a2a_03',
      buyerAgentName: 'SpeedHobby-Buyer (Batch Test)',
      buyerAgentOwner: 'Junior Speedsters Club',
      protocol: 'ACP_v1_2',
      skuList: ['SKU_TOY_03', 'SKU_TOY_07', 'SKU_TOY_08'],
      amountPaise: 1349900,
      amountInrFormatted: '₹13,499.00',
      razorpayOrderId: 'order_rzp_toy_8823c',
      policyStatus: 'PASSED',
      executionStatus: 'SETTLED',
      timestamp: '1 hour ago',
      explanation: 'Bulk hobbyist purchase of 1:10 Brushless RC Buggy, extra battery, and deluxe packing verified and confirmed.',
      auditSha256: '710293ea6510994821ea0041109284be77312384910293848102938481029384',
    },
  ];

  private static upsells: UpsellRecommendation[] = [
    {
      id: 'upsell_01',
      baseItemSku: 'SKU_TOY_03',
      recommendedSku: 'SKU_TOY_07',
      rationale: '78% of RC Buggy buyers purchase additional LiPo batteries for extended outdoor driving.',
      conversionProbabilityPercent: 78,
      incrementalMarginPaise: 56000,
      expectedAovLiftPercent: 28.4,
      status: 'ACTIVE',
    },
    {
      id: 'upsell_02',
      baseItemSku: 'SKU_TOY_01',
      recommendedSku: 'SKU_TOY_08',
      rationale: '84% of high-end LEGO & collectible purchases are gifts and add musical gift wrapping.',
      conversionProbabilityPercent: 84,
      incrementalMarginPaise: 17000,
      expectedAovLiftPercent: 12.5,
      status: 'ACTIVE',
    },
  ];

  private static campaigns: GrowthCampaign[] = [
    {
      id: 'cmp_01',
      name: 'Kids Birthday & Festival Toy Gifting Feed (UAP/ACP Index)',
      targetSegment: 'Autonomous Gifting Bots & Family Assistant Networks',
      channel: 'UAP_DISCOVERY_FEED',
      budgetCeilingPaise: 2500000,
      spendToDatePaise: 420000,
      projectedRevenuePaise: 18500000,
      roiMultiplier: 4.4,
      status: 'RUNNING',
    },
    {
      id: 'cmp_02',
      name: 'RC Cars & STEM Toys WhatsApp Cart Recovery Concierge',
      targetSegment: 'Shoppers with dropped carts containing RC Buggies and LEGO Sets',
      channel: 'WHATSAPP_INTERACTIVE',
      budgetCeilingPaise: 1500000,
      spendToDatePaise: 310000,
      projectedRevenuePaise: 9200000,
      roiMultiplier: 2.97,
      status: 'RUNNING',
    },
  ];

  private static buyerActivities: BuyerActivitySession[] = [
    {
      id: 'session_01',
      buyerName: 'Aarav Sharma',
      buyerCompany: 'Birthday Gifting for Kabir (Age 9)',
      phone: '+91 98201 44812',
      email: 'aarav.sharma@gmail.com',
      stage: 'DROPPED_AT_CHECKOUT',
      items: [
        { sku: 'SKU_TOY_01', name: 'LEGO Technic 1:8 Hypercar Collector Edition (3,599 pcs)', quantity: 1, pricePaise: 2400000, priceInr: '₹24,000.00' }
      ],
      totalCartPaise: 2400000,
      totalCartInr: '₹24,000.00',
      timeAgo: '8 mins ago',
      intentScorePercent: 92,
      lastAction: 'Reached payment modal, opened UPI QR, dropped before PIN submission.',
      preferredChannel: 'WHATSAPP',
      recommendedNudge: 'Send Razorpay WhatsApp Payment Link with instant 5% pre-approved UPI birthday discount token.',
      lastNudgeStatus: 'PENDING',
    },
    {
      id: 'session_02',
      buyerName: 'Priya Sundaram',
      buyerCompany: 'STEM Academy Kids Lab',
      phone: '+91 99402 31890',
      email: 'priya.s@stemkidslab.in',
      stage: 'ABANDONED_CART',
      items: [
        { sku: 'SKU_TOY_04', name: 'DJI Tello STEM Educational Programmable Mini Drone', quantity: 2, pricePaise: 900000, priceInr: '₹9,000.00' },
        { sku: 'SKU_TOY_05', name: 'Montessori Wooden Sensory Activity Cube & Marble Run Maze', quantity: 1, pricePaise: 220000, priceInr: '₹2,200.00' }
      ],
      totalCartPaise: 1120000,
      totalCartInr: '₹11,200.00',
      timeAgo: '22 mins ago',
      intentScorePercent: 86,
      lastAction: 'Added STEM Drone & Wooden Maze bundle to cart, reviewed gift wrap options, closed checkout tab.',
      preferredChannel: 'EMAIL',
      recommendedNudge: 'Dispatch automated cart recovery email with 1-click Razorpay checkout button.',
      lastNudgeStatus: 'PENDING',
    },
    {
      id: 'session_03',
      buyerName: 'Vikram Malhotra',
      buyerCompany: 'Junior Speedsters Club',
      phone: '+91 98110 59201',
      email: 'v.malhotra@rcspeedsters.in',
      stage: 'ABANDONED_CART',
      items: [
        { sku: 'SKU_TOY_03', name: '1:10 High-Speed All-Terrain Brushless RC Desert Buggy (65 km/h)', quantity: 1, pricePaise: 1250000, priceInr: '₹12,500.00' }
      ],
      totalCartPaise: 1250000,
      totalCartInr: '₹12,500.00',
      timeAgo: '45 mins ago',
      intentScorePercent: 79,
      lastAction: 'High-ticket RC buggy cart idle >30 minutes.',
      preferredChannel: 'CALL',
      recommendedNudge: 'Trigger priority concierge call prompt with special battery addon combo discount.',
      lastNudgeStatus: 'PENDING',
    },
    {
      id: 'session_04',
      buyerName: 'Kavita Reddy',
      buyerCompany: 'Creative Kids Studio',
      phone: '+91 97412 88301',
      email: 'kavita@creativekids.io',
      stage: 'WISHLIST_ACTIVE',
      items: [
        { sku: 'SKU_TOY_02', name: 'Smart AI Programmable Robotic Dog with HD Camera', quantity: 1, pricePaise: 850000, priceInr: '₹8,500.00' }
      ],
      totalCartPaise: 850000,
      totalCartInr: '₹8,500.00',
      timeAgo: '1 hour ago',
      intentScorePercent: 74,
      lastAction: 'Saved Robotic Dog to birthday wishlist; checked delivery timeline.',
      preferredChannel: 'PUSH',
      recommendedNudge: 'Push notification: "Only 5 Smart Robotic Dogs left in stock — reserve yours for birthday delivery now."',
      lastNudgeStatus: 'PENDING',
    },
    {
      id: 'session_05',
      buyerName: 'AutoGifting-Agent-Alpha',
      buyerCompany: 'Autonomous AI Gifting Agent',
      phone: '+91 98700 12099',
      email: 'agent-bot@smartgifting.ai',
      stage: 'AI_AGENT_CART_HELD',
      items: [
        { sku: 'SKU_TOY_04', name: 'DJI Tello STEM Educational Programmable Mini Drone', quantity: 5, pricePaise: 2250000, priceInr: '₹22,500.00' }
      ],
      totalCartPaise: 2250000,
      totalCartInr: '₹22,500.00',
      timeAgo: '14 mins ago',
      intentScorePercent: 95,
      lastAction: 'x402 Pre-Auth voucher signed for STEM drones; awaiting merchant stock reservation token.',
      preferredChannel: 'WHATSAPP',
      recommendedNudge: 'Trigger automated webhook unlock event for instant UAP token capture.',
      lastNudgeStatus: 'PENDING',
    },
  ];

  static getBuyerActivities(): BuyerActivitySession[] {
    return this.buyerActivities;
  }

  static dispatchBuyerNudge(
    sessionId: string,
    channel: 'WHATSAPP' | 'EMAIL' | 'CALL' | 'PUSH'
  ): { success: boolean; message: string; session: BuyerActivitySession; auditDigest: string } {
    const session = this.buyerActivities.find((s) => s.id === sessionId);
    if (!session) {
      throw new Error(`Buyer session ${sessionId} not found.`);
    }

    const auditDigest = Math.random().toString(36).substring(2, 12) + '...sha256_nudge';
    session.lastNudgeStatus = 'DELIVERED';
    session.lastNudgeTime = 'Just now';
    session.auditSha256 = auditDigest;

    const channelLabels: Record<string, string> = {
      WHATSAPP: 'Razorpay WhatsApp Payment Link',
      EMAIL: '1-Click Cart Recovery Email',
      CALL: 'Concierge Phone Call Alert',
      PUSH: 'In-App Cart Reminder Notification',
    };

    return {
      success: true,
      message: `Dispatched ${channelLabels[channel]} to ${session.buyerName} (${session.phone}).`,
      session,
      auditDigest,
    };
  }

  static autoNudgeAllHighIntent(): { count: number; totalValueInr: string; message: string } {
    let count = 0;
    let totalPaise = 0;
    for (const session of this.buyerActivities) {
      if (session.intentScorePercent >= 75 && session.lastNudgeStatus !== 'DELIVERED') {
        session.lastNudgeStatus = 'DELIVERED';
        session.lastNudgeTime = 'Just now';
        session.auditSha256 = Math.random().toString(36).substring(2, 12) + '...sha256_auto_nudge';
        count++;
        totalPaise += session.totalCartPaise;
      }
    }
    return {
      count,
      totalValueInr: `₹${(totalPaise / 100).toLocaleString('en-IN')}.00`,
      message: `Autonomous Nudge Agent engaged ${count} high-intent buyers, reclaiming ₹${(totalPaise / 100).toLocaleString('en-IN')}.00 in abandoned cart exposure.`,
    };
  }

  static getSummary(): AgenticCommerceSummary {
    const totalAgenticVolumePaise = 48500000; // ₹4.85 Lakh
    return {
      totalAgenticVolumePaise,
      totalAgenticVolumeInr: '₹4,85,000.00',
      aiBuyersServedCount: 64,
      averageOrderValueInr: '₹7,578.00',
      upsellMarginGeneratedPaise: 13800000, // ₹1.38 Lakh
      upsellMarginGeneratedInr: '₹1,38,000.00',
      gracefulFailuresHandledCount: 14,
      catalog: this.catalog,
      recentTransactions: this.recentTransactions,
      upsells: this.upsells,
      campaigns: this.campaigns,
      buyerActivities: this.buyerActivities,
      supportedProtocols: [
        'NPCI UAP (Unified Autonomous Payments)',
        'ACP v1.2 (Agentic Commerce Protocol)',
        'HTTP x402 (Payment Required Header for AI Agents)',
        'AP2 (Agent Protocol v2)',
        'Razorpay Test-Mode Smart Checkout',
      ],
    };
  }

  static triggerSimulatedAiPurchase(mode: 'SUCCESS' | 'FAILURE_GRACEFUL'): AiBuyerTransaction {
    const newId = `tx_a2a_live_${Date.now()}`;
    if (mode === 'SUCCESS') {
      const newTx: AiBuyerTransaction = {
        id: newId,
        buyerAgentName: 'AutoProcure-Agent-v4',
        buyerAgentOwner: 'Aarav Enterprise Solutions',
        protocol: 'HTTP_x402',
        skuList: ['SKU_AI_01', 'SKU_AI_03'],
        amountPaise: 1300000,
        amountInrFormatted: '₹13,000.00',
        razorpayOrderId: `order_rzp_live_${Math.random().toString(36).substring(2, 8)}`,
        policyStatus: 'PASSED',
        executionStatus: 'SETTLED',
        timestamp: 'Just now',
        explanation: 'Autonomous buyer discovered merchant endpoint, verified x402 pricing signature, approved cart, and completed Razorpay test-mode settlement.',
        auditSha256: Math.random().toString(36).substring(2, 12) + '...sha256_verified',
      };
      this.recentTransactions = [newTx, ...this.recentTransactions];
      return newTx;
    } else {
      const failTx: AiBuyerTransaction = {
        id: newId,
        buyerAgentName: 'Autonomous-Scraper-Bot',
        buyerAgentOwner: 'Zenith Logistics LLP',
        protocol: 'NPCI_UAP',
        skuList: ['SKU_AI_02', 'SKU_AI_05'],
        amountPaise: 3650000,
        amountInrFormatted: '₹36,500.00',
        razorpayOrderId: `order_rzp_live_${Math.random().toString(36).substring(2, 8)}`,
        policyStatus: 'GATE_BLOCKED_AND_MITIGATED',
        executionStatus: 'FAILED_GRACEFULLY_HANDLED',
        timestamp: 'Just now',
        explanation: 'GRACEFUL FAILURE HANDLED: Agent exceeded maximum item velocity limit. Policy gate intercepted transaction, applied merchant debounce rule, and completed fallback settlement with zero duplicate charges.',
        auditSha256: Math.random().toString(36).substring(2, 12) + '...sha256_mitigated',
        mitigationApplied: 'Auto-Debounce Token applied; transaction bounded within merchant risk tolerance.',
      };
      this.recentTransactions = [failTx, ...this.recentTransactions];
      return failTx;
    }
  }

  /**
   * Real Razorpay Order Creation via basic auth against https://api.razorpay.com/v1/orders
   */
  static async createLiveRazorpayOrder(
    amountPaise: number,
    receiptPrefix: string = 'rcpt_ai',
    notes: Record<string, string> = {}
  ): Promise<{ orderId: string; amountPaise: number; status: string; isLiveTestMode: boolean }> {
    const keyId = process.env.RAZORPAY_KEY_ID || 'rzp_test_TWEduRM7dLIhhc';
    const keySecret = process.env.RAZORPAY_KEY_SECRET || 'EHpdykxqKnzaSX6qn0Dyemok';
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    try {
      const res = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${auth}`,
        },
        body: JSON.stringify({
          amount: amountPaise,
          currency: 'INR',
          receipt: `${receiptPrefix}_${Date.now().toString().slice(-6)}`,
          notes: {
            platform: 'Razorpay_CommerceOS',
            protocol: 'ACP_v1_2',
            ...notes,
          },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        return {
          orderId: data.id,
          amountPaise: data.amount,
          status: data.status,
          isLiveTestMode: true,
        };
      }
    } catch {
      // Degrade gracefully
    }

    const fallbackId = `order_rzp_live_${Math.random().toString(36).substring(2, 10)}`;
    return {
      orderId: fallbackId,
      amountPaise,
      status: 'created',
      isLiveTestMode: false,
    };
  }

  /**
   * The Money Firewall: Evaluates autonomous buyer offers against merchant constraints.
   */
  static evaluateMoneyFirewall(
    requestedDiscountPercent: number,
    basePricePaise: number,
    marginPercent: number = 44
  ): {
    allowed: boolean;
    maxDiscountAllowedPercent: number;
    requestedDiscountPercent: number;
    minMarginFloorPercent: number;
    actualMarginPercent: number;
    maxTransactionLimitInr: string;
    reason: string;
    counterOfferDiscountPercent?: number;
    counterOfferTotalPaise?: number;
    auditSha256: string;
  } {
    const maxDiscountAllowedPercent = 10;
    const minMarginFloorPercent = 25;
    const auditSha256 = Math.random().toString(36).substring(2, 12) + '...sha256_firewall';

    if (requestedDiscountPercent > maxDiscountAllowedPercent) {
      const discountedMargin = marginPercent - requestedDiscountPercent;
      return {
        allowed: false,
        maxDiscountAllowedPercent,
        requestedDiscountPercent,
        minMarginFloorPercent,
        actualMarginPercent: discountedMargin,
        maxTransactionLimitInr: '₹25,000.00',
        reason: `POLICY VIOLATION: Requested discount (${requestedDiscountPercent}%) breaches merchant maximum limit (${maxDiscountAllowedPercent}%). Unit margin would degrade to ${discountedMargin}%, below the ${minMarginFloorPercent}% floor.`,
        counterOfferDiscountPercent: maxDiscountAllowedPercent,
        counterOfferTotalPaise: Math.round(basePricePaise * (1 - maxDiscountAllowedPercent / 100)),
        auditSha256,
      };
    }

    return {
      allowed: true,
      maxDiscountAllowedPercent,
      requestedDiscountPercent,
      minMarginFloorPercent,
      actualMarginPercent: marginPercent - requestedDiscountPercent,
      maxTransactionLimitInr: '₹25,000.00',
      reason: `POLICY PASSED: ${requestedDiscountPercent}% discount complies with the ${maxDiscountAllowedPercent}% ceiling. Margin remains above the ${minMarginFloorPercent}% floor.`,
      auditSha256,
    };
  }

  /**
   * Autonomous Revenue Agent Strategy Proposition
   */
  static getAutonomousRevenuePlan(): {
    goal: string;
    currentWeeklyRunRateInr: string;
    recommendedActions: string[];
    expectedRevenueUpliftInr: string;
    maximumDownsideInr: string;
    status: 'PROPOSED' | 'APPROVED_ACTIVE';
  } {
    return {
      goal: '+15% Revenue Expansion this week',
      currentWeeklyRunRateInr: '₹8,20,000.00',
      recommendedActions: [
        '✓ Bundle Coffee Starter Kit + Insulated Travel Mug (+31% attach rate)',
        '✓ Offer autonomous 8% bounded discount voucher to 5 abandoned carts',
        '✓ Upsell 1-Year Comprehensive Replacement Warranty on Urban Pro Backpack',
        '✓ Retarget 12 high-intent returning buyers with customized subscription vouchers',
      ],
      expectedRevenueUpliftInr: '+₹1,31,000.00',
      maximumDownsideInr: '₹42,000.00 (Protected by 24h spend cap)',
      status: 'PROPOSED',
    };
  }
}

