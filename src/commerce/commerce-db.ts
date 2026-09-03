/**
 * CommerceOS Database Layer
 *
 * All commerce operations read/write Supabase. When Supabase is unavailable,
 * falls back gracefully to in-memory seed data (for offline development).
 *
 * This is the single data access layer for the commerce system. No other module
 * should import @supabase/supabase-js directly.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { computeAuditDigest, generateEventId } from './commerce-crypto';

/* -------------------------------------------------------------------------- */
/* Domain types                                                               */
/* -------------------------------------------------------------------------- */

export interface CommerceProduct {
  id: string;
  merchantId: string;
  name: string;
  description: string;
  pricePaise: number;
  costPaise: number;
  marginPercent: number;
  inventory: number;
  category: string;
  aiMetadata: {
    useCases: string[];
    features: string[];
    giftable: boolean;
    deliveryDays: number;
  };
}

export interface MerchantPolicy {
  merchantId: string;
  maxDiscountPercent: number;
  minimumMarginPercent: number;
  maxTransactionPaise: number;
  autoApprovalLimitPaise: number;
  dailyRefundLimitPaise: number;
}

export type OrderStatus =
  | 'CREATED'
  | 'PAYMENT_INITIATED'
  | 'PAYMENT_PENDING'
  | 'PAYMENT_VERIFICATION'
  | 'PAID'
  | 'ORDER_CONFIRMED'
  | 'VERIFYING_TIMEOUT'
  | 'CANCELLED'
  | 'REFUNDED';

export interface CommerceOrder {
  id: string;
  merchantId: string;
  buyerAgentId: string;
  subtotalPaise: number;
  discountPaise: number;
  upsellPaise: number;
  totalPaise: number;
  status: OrderStatus;
  createdAt: string;
  updatedAt?: string;
}

export interface CommerceOrderItem {
  id: string;
  orderId: string;
  productId: string;
  quantity: number;
  unitPricePaise: number;
  discountPaise: number;
  itemType: 'BASE_PRODUCT' | 'UPSELL_ATTACHMENT';
}

export type TransactionStatus = 'INITIATED' | 'PENDING' | 'VERIFYING' | 'CAPTURED' | 'FAILED';

export interface CommerceTransaction {
  id: string;
  orderId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  amountPaise: number;
  status: TransactionStatus;
  idempotencyKey: string;
  createdAt: string;
  settledAt: string | null;
}

export type AuditActor = 'AI_BUYER' | 'MERCHANT_AGENT' | 'MONEY_FIREWALL' | 'RAZORPAY_GATEWAY' | 'REVENUE_AGENT' | 'SYSTEM';
export type AuditResult = 'APPROVED' | 'BLOCKED' | 'COUNTERED' | 'VERIFIED' | 'FAILED';

export interface CommerceAuditEvent {
  id: string;
  transactionId?: string;
  orderId?: string;
  timestamp: string;
  actor: AuditActor;
  action: string;
  input: Record<string, unknown>;
  decision: Record<string, unknown>;
  reason: string;
  policySnapshot: Record<string, unknown>;
  result: AuditResult;
  sha256Digest: string;
}

export type StrategyStatus = 'PROPOSED' | 'APPROVED' | 'EXECUTING' | 'COMPLETED';

export interface RevenueStrategy {
  id: string;
  merchantId: string;
  goal: string;
  currentRunRatePaise: number;
  expectedUpliftPaise: number;
  maximumDownsidePaise: number;
  proposedActions: Record<string, unknown>[];
  status: StrategyStatus;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Seed data (fallback when Supabase is unavailable)                          */
/* -------------------------------------------------------------------------- */

const SEED_PRODUCTS: CommerceProduct[] = [
  {
    id: 'prod_001',
    merchantId: 'merchant_001',
    name: '1:10 High-Speed All-Terrain Brushless RC Monster Truck (60 km/h)',
    description: 'Waterproof 4WD chassis with oil shocks, 2.4GHz remote control, and high-traction rubber tires.',
    pricePaise: 399900,
    costPaise: 231900,
    marginPercent: 42.0,
    inventory: 82,
    category: 'Remote Control & Vehicles',
    aiMetadata: {
      useCases: ['rc car', 'toy', 'birthday gift', 'remote control', 'outdoor speed'],
      features: ['waterproof', '4wd brushless motor', '2.4ghz remote', '60km/h speed', 'metal shocks'],
      giftable: true,
      deliveryDays: 1,
    },
  },
  {
    id: 'prod_002',
    merchantId: 'merchant_001',
    name: 'Extra High-Capacity LiPo Battery & USB-C Quick Charger',
    description: 'Long-lasting 3000mAh battery pack giving 45+ minutes of continuous RC and robotics play time.',
    pricePaise: 80000,
    costPaise: 24000,
    marginPercent: 70.0,
    inventory: 150,
    category: 'Addons',
    aiMetadata: {
      useCases: ['rc addon', 'extra battery', 'toys'],
      features: ['fast-charge', 'lipo-safe', 'extended-playtime'],
      giftable: true,
      deliveryDays: 1,
    },
  },
  {
    id: 'prod_003',
    merchantId: 'merchant_001',
    name: 'Smart AI STEM Programmable Robotics Kit for Kids (Ages 8-14)',
    description: 'Interactive STEM robot with ultrasonic obstacle sensors, line tracking, and Scratch/Python coding support.',
    pricePaise: 449900,
    costPaise: 251900,
    marginPercent: 44.0,
    inventory: 48,
    category: 'STEM & Educational',
    aiMetadata: {
      useCases: ['educational toy', 'coding robot', 'stem kit', 'birthday gift', 'kids gift'],
      features: ['scratch coding', 'python ready', 'obstacle sensor', 'bluetooth app'],
      giftable: true,
      deliveryDays: 1,
    },
  },
  {
    id: 'prod_004',
    merchantId: 'merchant_001',
    name: 'Deluxe Birthday Toy Gift Wrapping with Musical Greeting Card',
    description: 'Festive toy packaging with customized handwritten birthday note and musical pop-up card.',
    pricePaise: 19900,
    costPaise: 2900,
    marginPercent: 85.4,
    inventory: 500,
    category: 'Addons',
    aiMetadata: {
      useCases: ['birthday gift', 'celebration', 'gift wrap', 'kids party'],
      features: ['gift-wrap', 'musical-card', 'customized note', 'ribbon bow'],
      giftable: true,
      deliveryDays: 0,
    },
  },
  {
    id: 'prod_005',
    merchantId: 'merchant_001',
    name: 'LEGO Technic Heavy-Duty Rescue Tow Truck (2,017 pcs)',
    description: 'Authentic engineering marvel with pneumatic crane arm, working 6-cylinder engine, and outriggers.',
    pricePaise: 900000,
    costPaise: 450000,
    marginPercent: 50.0,
    inventory: 35,
    category: 'Building Sets & LEGO',
    aiMetadata: {
      useCases: ['lego', 'building toy', 'collector set', 'teen gift'],
      features: ['pneumatic crane', '2017 pieces', 'working winch', 'v6 engine'],
      giftable: true,
      deliveryDays: 1,
    },
  },
  {
    id: 'prod_006',
    merchantId: 'merchant_001',
    name: '1-Year Unlimited Toy Replacement Guarantee & Damage Care',
    description: 'Comprehensive accidental damage and broken parts replacement protection for all hobby toys.',
    pricePaise: 250000,
    costPaise: 25000,
    marginPercent: 90.0,
    inventory: 100,
    category: 'Protection Addon',
    aiMetadata: {
      useCases: ['toy warranty', 'accidental protection', 'peace of mind'],
      features: ['instant replacement', 'broken-gear repair', 'zero hassle'],
      giftable: false,
      deliveryDays: 0,
    },
  },
];

const SEED_POLICY: MerchantPolicy = {
  merchantId: 'merchant_001',
  maxDiscountPercent: 10.0,
  minimumMarginPercent: 25.0,
  maxTransactionPaise: 2500000,
  autoApprovalLimitPaise: 1000000,
  dailyRefundLimitPaise: 500000,
};

/* -------------------------------------------------------------------------- */
/* In-memory stores (fallback)                                                */
/* -------------------------------------------------------------------------- */

let localProducts: CommerceProduct[] = [...SEED_PRODUCTS];
let localOrders: CommerceOrder[] = [];
let localOrderItems: CommerceOrderItem[] = [];
let localTransactions: CommerceTransaction[] = [];
let localAuditEvents: CommerceAuditEvent[] = [];
let localStrategies: RevenueStrategy[] = [];
let localPolicy: MerchantPolicy = { ...SEED_POLICY };

/* -------------------------------------------------------------------------- */
/* Supabase client                                                            */
/* -------------------------------------------------------------------------- */

let supabaseClient: SupabaseClient | null = null;
let supabaseAvailable: boolean | null = null; // null = not checked yet

function getClient(): SupabaseClient | null {
  if (supabaseClient) return supabaseClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (url && key) {
    try {
      supabaseClient = createClient(url, key, { auth: { persistSession: false } });
    } catch {
      supabaseAvailable = false;
    }
  }
  return supabaseClient;
}

/** Quick connectivity check — cached after first call */
async function isSupabaseReady(): Promise<boolean> {
  if (supabaseAvailable !== null) return supabaseAvailable;
  const client = getClient();
  if (!client) {
    supabaseAvailable = false;
    return false;
  }
  try {
    const { error } = await client.from('commerce_merchants').select('id').limit(1);
    supabaseAvailable = !error;
  } catch {
    supabaseAvailable = false;
  }
  return supabaseAvailable;
}

/* -------------------------------------------------------------------------- */
/* Row mappers (Supabase snake_case → TypeScript camelCase)                   */
/* -------------------------------------------------------------------------- */

function mapProduct(row: Record<string, unknown>): CommerceProduct {
  const meta = (row.ai_metadata ?? {}) as Record<string, unknown>;
  return {
    id: row.id as string,
    merchantId: row.merchant_id as string,
    name: row.name as string,
    description: row.description as string,
    pricePaise: Number(row.price_paise),
    costPaise: Number(row.cost_paise),
    marginPercent: Number(row.margin_percent ?? 0),
    inventory: Number(row.inventory),
    category: row.category as string,
    aiMetadata: {
      useCases: (meta.use_cases ?? []) as string[],
      features: (meta.features ?? []) as string[],
      giftable: Boolean(meta.giftable),
      deliveryDays: Number(meta.delivery_days ?? 1),
    },
  };
}

function mapOrder(row: Record<string, unknown>): CommerceOrder {
  return {
    id: row.id as string,
    merchantId: row.merchant_id as string,
    buyerAgentId: row.buyer_agent_id as string,
    subtotalPaise: Number(row.subtotal_paise),
    discountPaise: Number(row.discount_paise),
    upsellPaise: Number(row.upsell_paise),
    totalPaise: Number(row.total_paise),
    status: row.status as OrderStatus,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string | undefined,
  };
}

function mapTransaction(row: Record<string, unknown>): CommerceTransaction {
  return {
    id: row.id as string,
    orderId: row.order_id as string,
    razorpayOrderId: row.razorpay_order_id as string,
    razorpayPaymentId: (row.razorpay_payment_id as string) ?? null,
    amountPaise: Number(row.amount_paise),
    status: row.status as TransactionStatus,
    idempotencyKey: row.idempotency_key as string,
    createdAt: row.created_at as string,
    settledAt: (row.settled_at as string) ?? null,
  };
}

function mapAuditEvent(row: Record<string, unknown>): CommerceAuditEvent {
  return {
    id: row.id as string,
    transactionId: (row.transaction_id as string) ?? undefined,
    orderId: (row.order_id as string) ?? undefined,
    timestamp: row.timestamp as string,
    actor: row.actor as AuditActor,
    action: row.action as string,
    input: (row.input ?? {}) as Record<string, unknown>,
    decision: (row.decision ?? {}) as Record<string, unknown>,
    reason: row.reason as string,
    policySnapshot: (row.policy_snapshot ?? {}) as Record<string, unknown>,
    result: row.result as AuditResult,
    sha256Digest: row.sha256_digest as string,
  };
}

function mapStrategy(row: Record<string, unknown>): RevenueStrategy {
  return {
    id: row.id as string,
    merchantId: row.merchant_id as string,
    goal: row.goal as string,
    currentRunRatePaise: Number(row.current_run_rate_paise),
    expectedUpliftPaise: Number(row.expected_uplift_paise),
    maximumDownsidePaise: Number(row.maximum_downside_paise),
    proposedActions: (row.proposed_actions ?? []) as Record<string, unknown>[],
    status: row.status as StrategyStatus,
    createdAt: row.created_at as string,
  };
}

/* -------------------------------------------------------------------------- */
/* CommerceDatabase — the single data access layer                            */
/* -------------------------------------------------------------------------- */

export class CommerceDatabase {

  /* ---- Products ---- */

  static async getProducts(filters?: { category?: string; giftable?: boolean; merchantId?: string }): Promise<CommerceProduct[]> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      let query = client.from('commerce_products').select('*');
      if (filters?.merchantId) query = query.eq('merchant_id', filters.merchantId);
      if (filters?.category) query = query.ilike('category', `%${filters.category}%`);
      const { data, error } = await query;
      if (!error && data && data.length > 0) {
        let products = data.map(mapProduct);
        if (filters?.giftable !== undefined) {
          products = products.filter((p) => p.aiMetadata.giftable === filters.giftable);
        }
        return products;
      }
    }
    // Fallback to local
    let items = [...localProducts];
    if (filters?.category) {
      items = items.filter((p) => p.category.toLowerCase().includes(filters.category!.toLowerCase()));
    }
    if (filters?.giftable !== undefined) {
      items = items.filter((p) => p.aiMetadata.giftable === filters.giftable);
    }
    return items;
  }

  static async getProductById(id: string): Promise<CommerceProduct | null> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      const { data, error } = await client.from('commerce_products').select('*').eq('id', id).limit(1);
      if (!error && data && data.length > 0) return mapProduct(data[0]!);
    }
    return localProducts.find((p) => p.id === id) || null;
  }

  static async decrementInventory(productId: string, quantity: number = 1): Promise<boolean> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      const { error } = await client.rpc('decrement_inventory', { p_product_id: productId, p_quantity: quantity }).maybeSingle();
      if (!error) return true;
      // Fallback: manual check and update
      const { data: product } = await client.from('commerce_products').select('inventory').eq('id', productId).single();
      if (product && product.inventory >= quantity) {
        await client.from('commerce_products').update({ inventory: product.inventory - quantity }).eq('id', productId);
        return true;
      }
    }
    // Fallback
    const p = localProducts.find((prod) => prod.id === productId);
    if (p && p.inventory >= quantity) {
      p.inventory -= quantity;
      return true;
    }
    return false;
  }

  /* ---- Merchant Policies ---- */

  static async getMerchantPolicy(merchantId: string = 'merchant_001'): Promise<MerchantPolicy> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      const { data, error } = await client.from('commerce_merchant_policies').select('*').eq('merchant_id', merchantId).limit(1);
      if (!error && data && data.length > 0) {
        const row = data[0]!;
        return {
          merchantId: row.merchant_id as string,
          maxDiscountPercent: Number(row.max_discount_percent),
          minimumMarginPercent: Number(row.minimum_margin_percent),
          maxTransactionPaise: Number(row.max_transaction_paise),
          autoApprovalLimitPaise: Number(row.auto_approval_limit_paise),
          dailyRefundLimitPaise: Number(row.daily_refund_limit_paise),
        };
      }
    }
    return { ...localPolicy };
  }

  static async updateMerchantPolicy(policy: Partial<MerchantPolicy>): Promise<MerchantPolicy> {
    const current = await this.getMerchantPolicy(policy.merchantId || 'merchant_001');
    const updated = { ...current, ...policy };

    if (await isSupabaseReady()) {
      const client = getClient()!;
      await client.from('commerce_merchant_policies').upsert({
        merchant_id: updated.merchantId,
        max_discount_percent: updated.maxDiscountPercent,
        minimum_margin_percent: updated.minimumMarginPercent,
        max_transaction_paise: updated.maxTransactionPaise,
        auto_approval_limit_paise: updated.autoApprovalLimitPaise,
        daily_refund_limit_paise: updated.dailyRefundLimitPaise,
        updated_at: new Date().toISOString(),
      });
    }

    localPolicy = updated;
    return updated;
  }

  /* ---- Orders ---- */

  static async createOrder(order: CommerceOrder): Promise<CommerceOrder> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      await client.from('commerce_orders').insert({
        id: order.id,
        merchant_id: order.merchantId,
        buyer_agent_id: order.buyerAgentId,
        subtotal_paise: order.subtotalPaise,
        discount_paise: order.discountPaise,
        upsell_paise: order.upsellPaise,
        total_paise: order.totalPaise,
        status: order.status,
        created_at: order.createdAt,
        updated_at: order.createdAt,
      });
    }
    localOrders = [order, ...localOrders];
    return order;
  }

  static async updateOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      await client.from('commerce_orders').update({ status, updated_at: new Date().toISOString() }).eq('id', orderId);
    }
    const o = localOrders.find((ord) => ord.id === orderId);
    if (o) o.status = status;
  }

  static async getOrderById(orderId: string): Promise<CommerceOrder | null> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      const { data, error } = await client.from('commerce_orders').select('*').eq('id', orderId).limit(1);
      if (!error && data && data.length > 0) return mapOrder(data[0]!);
    }
    return localOrders.find((o) => o.id === orderId) || null;
  }

  static async getRecentOrders(limit: number = 20): Promise<CommerceOrder[]> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      const { data, error } = await client.from('commerce_orders').select('*').order('created_at', { ascending: false }).limit(limit);
      if (!error && data) return data.map(mapOrder);
    }
    return localOrders.slice(0, limit);
  }

  /* ---- Order Items ---- */

  static async createOrderItem(item: CommerceOrderItem): Promise<void> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      await client.from('commerce_order_items').insert({
        id: item.id,
        order_id: item.orderId,
        product_id: item.productId,
        quantity: item.quantity,
        unit_price_paise: item.unitPricePaise,
        discount_paise: item.discountPaise,
        item_type: item.itemType,
      });
    }
    localOrderItems.push(item);
  }

  /* ---- Transactions ---- */

  static async createTransaction(tx: CommerceTransaction): Promise<CommerceTransaction> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      await client.from('commerce_transactions').insert({
        id: tx.id,
        order_id: tx.orderId,
        razorpay_order_id: tx.razorpayOrderId,
        razorpay_payment_id: tx.razorpayPaymentId,
        amount_paise: tx.amountPaise,
        status: tx.status,
        idempotency_key: tx.idempotencyKey,
        created_at: tx.createdAt,
        settled_at: tx.settledAt,
      });
    }
    localTransactions = [tx, ...localTransactions];
    return tx;
  }

  static async updateTransactionStatus(
    txId: string,
    status: TransactionStatus,
    updates?: { razorpayPaymentId?: string; settledAt?: string }
  ): Promise<void> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      const updateData: Record<string, unknown> = { status };
      if (updates?.razorpayPaymentId) updateData.razorpay_payment_id = updates.razorpayPaymentId;
      if (updates?.settledAt) updateData.settled_at = updates.settledAt;
      await client.from('commerce_transactions').update(updateData).eq('id', txId);
    }
    const t = localTransactions.find((tr) => tr.id === txId);
    if (t) {
      t.status = status;
      if (updates?.razorpayPaymentId) t.razorpayPaymentId = updates.razorpayPaymentId;
      if (updates?.settledAt) t.settledAt = updates.settledAt;
    }
  }

  static async getTransactionByIdempotencyKey(key: string): Promise<CommerceTransaction | null> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      const { data, error } = await client.from('commerce_transactions').select('*').eq('idempotency_key', key).limit(1);
      if (!error && data && data.length > 0) return mapTransaction(data[0]!);
    }
    return localTransactions.find((t) => t.idempotencyKey === key) || null;
  }

  static async getTransactionByRazorpayOrderId(razorpayOrderId: string): Promise<CommerceTransaction | null> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      const { data, error } = await client.from('commerce_transactions').select('*').eq('razorpay_order_id', razorpayOrderId).limit(1);
      if (!error && data && data.length > 0) return mapTransaction(data[0]!);
    }
    return localTransactions.find((t) => t.razorpayOrderId === razorpayOrderId) || null;
  }

  static async getTransactionById(txId: string): Promise<CommerceTransaction | null> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      const { data, error } = await client.from('commerce_transactions').select('*').eq('id', txId).limit(1);
      if (!error && data && data.length > 0) return mapTransaction(data[0]!);
    }
    return localTransactions.find((t) => t.id === txId) || null;
  }

  /* ---- Audit Events ---- */

  static async recordAuditEvent(event: Omit<CommerceAuditEvent, 'id' | 'sha256Digest' | 'timestamp'>): Promise<CommerceAuditEvent> {
    // Get the last digest for chain-linking
    const lastDigest = localAuditEvents.length > 0
      ? localAuditEvents[0]!.sha256Digest
      : 'GENESIS';

    const fullEvent: CommerceAuditEvent = {
      id: generateEventId(),
      timestamp: new Date().toISOString(),
      sha256Digest: computeAuditDigest(
        {
          transaction_id: event.transactionId,
          order_id: event.orderId,
          actor: event.actor,
          action: event.action,
          input: event.input,
          decision: event.decision,
          reason: event.reason,
          policy_snapshot: event.policySnapshot,
          result: event.result,
        },
        lastDigest
      ),
      ...event,
    };

    if (await isSupabaseReady()) {
      const client = getClient()!;
      await client.from('commerce_audit_events').insert({
        id: fullEvent.id,
        transaction_id: fullEvent.transactionId || null,
        order_id: fullEvent.orderId || null,
        timestamp: fullEvent.timestamp,
        actor: fullEvent.actor,
        action: fullEvent.action,
        input: fullEvent.input,
        decision: fullEvent.decision,
        reason: fullEvent.reason,
        policy_snapshot: fullEvent.policySnapshot,
        result: fullEvent.result,
        sha256_digest: fullEvent.sha256Digest,
      });
    }

    localAuditEvents = [fullEvent, ...localAuditEvents];
    return fullEvent;
  }

  static async getAuditEvents(filters?: { orderId?: string; transactionId?: string; limit?: number }): Promise<CommerceAuditEvent[]> {
    const limit = filters?.limit ?? 50;

    if (await isSupabaseReady()) {
      const client = getClient()!;
      let query = client.from('commerce_audit_events').select('*').order('timestamp', { ascending: false }).limit(limit);
      if (filters?.orderId) query = query.eq('order_id', filters.orderId);
      if (filters?.transactionId) query = query.eq('transaction_id', filters.transactionId);
      const { data, error } = await query;
      if (!error && data) return data.map(mapAuditEvent);
    }

    let events = [...localAuditEvents];
    if (filters?.orderId) events = events.filter((e) => e.orderId === filters.orderId);
    if (filters?.transactionId) events = events.filter((e) => e.transactionId === filters.transactionId);
    return events.slice(0, limit);
  }

  /* ---- Revenue Strategies ---- */

  static async createStrategy(strategy: RevenueStrategy): Promise<RevenueStrategy> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      await client.from('commerce_revenue_strategies').insert({
        id: strategy.id,
        merchant_id: strategy.merchantId,
        goal: strategy.goal,
        current_run_rate_paise: strategy.currentRunRatePaise,
        expected_uplift_paise: strategy.expectedUpliftPaise,
        maximum_downside_paise: strategy.maximumDownsidePaise,
        proposed_actions: strategy.proposedActions,
        status: strategy.status,
        created_at: strategy.createdAt,
      });
    }
    localStrategies = [strategy, ...localStrategies];
    return strategy;
  }

  static async updateStrategyStatus(strategyId: string, status: StrategyStatus): Promise<void> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      await client.from('commerce_revenue_strategies').update({ status }).eq('id', strategyId);
    }
    const s = localStrategies.find((st) => st.id === strategyId);
    if (s) s.status = status;
  }

  static async getStrategies(merchantId: string = 'merchant_001'): Promise<RevenueStrategy[]> {
    if (await isSupabaseReady()) {
      const client = getClient()!;
      const { data, error } = await client.from('commerce_revenue_strategies').select('*').eq('merchant_id', merchantId).order('created_at', { ascending: false });
      if (!error && data) return data.map(mapStrategy);
    }
    return localStrategies.filter((s) => s.merchantId === merchantId);
  }

  /* ---- Aggregation (for dashboard & revenue agent) ---- */

  static async getOrderStats(merchantId: string = 'merchant_001'): Promise<{
    totalRevenuePaise: number;
    aiRevenuePaise: number;
    totalOrders: number;
    aiOrders: number;
    averageOrderValuePaise: number;
  }> {
    const orders = await this.getRecentOrders(1000);
    const confirmed = orders.filter((o) => o.status === 'ORDER_CONFIRMED' || o.status === 'PAID');
    const totalRevenuePaise = confirmed.reduce((sum, o) => sum + o.totalPaise, 0);
    const aiOrders = confirmed.filter((o) => o.buyerAgentId.startsWith('ai_buyer'));
    const aiRevenuePaise = aiOrders.reduce((sum, o) => sum + o.totalPaise, 0);

    return {
      totalRevenuePaise,
      aiRevenuePaise,
      totalOrders: confirmed.length,
      aiOrders: aiOrders.length,
      averageOrderValuePaise: confirmed.length > 0 ? Math.round(totalRevenuePaise / confirmed.length) : 0,
    };
  }

  static async getFirewallBlockCount(): Promise<number> {
    const events = await this.getAuditEvents({ limit: 1000 });
    return events.filter((e) => e.result === 'BLOCKED').length;
  }
}
