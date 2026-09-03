-- ============================================================================
-- FinanceOS / Razorpay CommerceOS — AI-Native Commerce Schema (Migration 12)
-- ============================================================================

-- 1. Merchants Table
CREATE TABLE IF NOT EXISTS commerce_merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  capabilities JSONB NOT NULL DEFAULT '["catalog","offers","checkout","payment","orders","refunds"]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Products & AI Discovery Metadata
CREATE TABLE IF NOT EXISTS commerce_products (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES commerce_merchants(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price_paise BIGINT NOT NULL CHECK (price_paise > 0),
  cost_paise BIGINT NOT NULL CHECK (cost_paise >= 0),
  margin_percent NUMERIC(5,2) GENERATED ALWAYS AS (
    ROUND(((price_paise - cost_paise)::numeric / price_paise::numeric) * 100, 2)
  ) STORED,
  inventory INT NOT NULL DEFAULT 0 CHECK (inventory >= 0),
  category TEXT NOT NULL,
  ai_metadata JSONB NOT NULL DEFAULT '{
    "use_cases": [],
    "features": [],
    "giftable": false,
    "delivery_days": 1
  }'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Merchant Policy Matrix (The Money Firewall Bounds)
CREATE TABLE IF NOT EXISTS commerce_merchant_policies (
  merchant_id TEXT PRIMARY KEY REFERENCES commerce_merchants(id),
  max_discount_percent NUMERIC(5,2) NOT NULL DEFAULT 10.00,
  minimum_margin_percent NUMERIC(5,2) NOT NULL DEFAULT 25.00,
  max_transaction_paise BIGINT NOT NULL DEFAULT 2500000, -- ₹25,000.00
  auto_approval_limit_paise BIGINT NOT NULL DEFAULT 1000000, -- ₹10,000.00
  daily_refund_limit_paise BIGINT NOT NULL DEFAULT 500000, -- ₹5,000.00
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Commerce Orders
CREATE TABLE IF NOT EXISTS commerce_orders (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES commerce_merchants(id),
  buyer_agent_id TEXT NOT NULL,
  subtotal_paise BIGINT NOT NULL,
  discount_paise BIGINT NOT NULL DEFAULT 0,
  upsell_paise BIGINT NOT NULL DEFAULT 0,
  total_paise BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'CREATED', 'PAYMENT_INITIATED', 'PAYMENT_PENDING',
    'PAYMENT_VERIFICATION', 'PAID', 'ORDER_CONFIRMED',
    'VERIFYING_TIMEOUT', 'CANCELLED', 'REFUNDED'
  )),
  delivery_address JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Order Items Breakdown
CREATE TABLE IF NOT EXISTS commerce_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES commerce_products(id),
  quantity INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_paise BIGINT NOT NULL,
  discount_paise BIGINT NOT NULL DEFAULT 0,
  item_type TEXT NOT NULL CHECK (item_type IN ('BASE_PRODUCT', 'UPSELL_ATTACHMENT'))
);

-- 6. Transactions & Correlation Identifiers
CREATE TABLE IF NOT EXISTS commerce_transactions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES commerce_orders(id),
  razorpay_order_id TEXT NOT NULL,
  razorpay_payment_id TEXT,
  amount_paise BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('INITIATED', 'PENDING', 'VERIFYING', 'CAPTURED', 'FAILED')),
  idempotency_key TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ
);

-- 7. Immutable Audit Ledger (WHO → WHAT → WHY → POLICY → RESULT)
CREATE TABLE IF NOT EXISTS commerce_audit_events (
  id TEXT PRIMARY KEY,
  transaction_id TEXT,
  order_id TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT NOT NULL CHECK (actor IN ('AI_BUYER', 'MERCHANT_AGENT', 'MONEY_FIREWALL', 'RAZORPAY_GATEWAY')),
  action TEXT NOT NULL,
  input JSONB NOT NULL,
  decision JSONB NOT NULL,
  reason TEXT NOT NULL,
  policy_snapshot JSONB NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('APPROVED', 'BLOCKED', 'COUNTERED', 'VERIFIED', 'FAILED')),
  sha256_digest TEXT NOT NULL
);

-- 8. Autonomous Revenue Strategies
CREATE TABLE IF NOT EXISTS commerce_revenue_strategies (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES commerce_merchants(id),
  goal TEXT NOT NULL,
  current_run_rate_paise BIGINT NOT NULL,
  expected_uplift_paise BIGINT NOT NULL,
  maximum_downside_paise BIGINT NOT NULL,
  proposed_actions JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'APPROVED', 'EXECUTING', 'COMPLETED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- Seed Acme Travel & AI Catalog Data
-- ============================================================================
INSERT INTO commerce_merchants (id, name, currency, status)
VALUES ('merchant_001', 'Acme Travel & Gear', 'INR', 'ACTIVE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO commerce_merchant_policies (merchant_id, max_discount_percent, minimum_margin_percent, max_transaction_paise)
VALUES ('merchant_001', 10.00, 25.00, 2500000)
ON CONFLICT (merchant_id) DO NOTHING;

INSERT INTO commerce_products (id, merchant_id, name, description, price_paise, cost_paise, inventory, category, ai_metadata)
VALUES
  ('prod_001', 'merchant_001', 'Urban Pro Waterproof Laptop Backpack (15.6 inch)', 'Waterproof IPX5 ballistic nylon backpack with padded laptop compartment.', 399900, 231900, 82, 'Gear & Travel', '{"use_cases":["commute","travel"],"features":["waterproof","15-inch laptop sleeve"],"giftable":true,"delivery_days":1}'::jsonb),
  ('prod_002', 'merchant_001', 'Compression Packing Cubes & Passport Organizer', 'Ultralight water-resistant packing cubes designed to fit Urban Pro backpack.', 80000, 24000, 150, 'Addons', '{"use_cases":["travel"],"features":["compression","water-resistant"],"giftable":true,"delivery_days":1}'::jsonb),
  ('prod_003', 'merchant_001', 'Premium Coffee Starter Kit (Whole Bean + Burr Grinder)', 'Single-origin Arabica beans, conical burr hand grinder, and insulated pour-over dripper.', 449900, 251900, 48, 'Lifestyle & Gourmet', '{"use_cases":["gourmet","home"],"features":["whole-bean","burr grinder"],"giftable":true,"delivery_days":1}'::jsonb),
  ('prod_004', 'merchant_001', 'Artisanal Gift Wrapping & Handwritten Letter Card', 'Festive craft packaging with customized handwritten greeting message.', 19900, 2900, 500, 'Addons', '{"use_cases":["gift"],"features":["gift-wrap","handwritten-card"],"giftable":true,"delivery_days":0}'::jsonb),
  ('prod_005', 'merchant_001', 'Enterprise Cloud API Capacity (2M Tokens)', 'High-throughput low-latency inference endpoint capacity for autonomous workloads.', 900000, 180000, 9999, 'API Credits', '{"use_cases":["b2b","ai"],"features":["low-latency","high-concurrency"],"giftable":false,"delivery_days":0}'::jsonb),
  ('prod_006', 'merchant_001', 'Priority 99.99% Route SLA & Dedicated Gateway Node', 'Guarantees sub-50ms clearing latency and bypass of transient congestion.', 250000, 25000, 100, 'Infrastructure Addon', '{"use_cases":["b2b","infrastructure"],"features":["sla","dedicated-gateway"],"giftable":false,"delivery_days":0}'::jsonb)
ON CONFLICT (id) DO NOTHING;
