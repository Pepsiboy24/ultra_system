-- ============================================================
-- Live DB migration — Restaurant order flow.
--
-- Run ONCE against the production Supabase (SQL editor):
-- "migration" on the project. Each statement is guarded so a
-- re-run is safe.
--
-- Adds:
--   1) products.is_available          — menu availability flag that replaces
--      the stock_quantity model for 'restaurant' clients (independent of
--      stock_quantity, which stays for b2b/dropshipper).
--   2) clients.offers_delivery / offers_pickup / accepting_orders
--      — client-level toggles for the restaurant flow.
--   3) orders.order_type              — 'delivery' | 'pickup' | null, captured
--      from the delivery/pickup button message so READY <short> can tell the
--      customer "ready for pickup" vs "out for delivery".
--   4) processed_messages table       — webhook message-id deduplication.
-- ============================================================

-- 1) products: menu availability for restaurants (independent of stock).
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT true;

-- 2) clients: restaurant delivery/pickup/accepting-orders toggles.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS offers_delivery BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS offers_pickup   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS accepting_orders BOOLEAN NOT NULL DEFAULT true;

-- 3) orders: fulfillment type chosen from the delivery/pickup button (only
--    set for restaurant orders). Nullable for b2b/dropshipper orders, which
--    never populate it.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS order_type TEXT
    CHECK (order_type IN ('delivery', 'pickup') OR order_type IS NULL);

-- 4) processed_messages: webhook dedup. Primary key is the WhatsApp message
--    id so a redelivered webhook (Meta retries / re-fetch on failure) is
--    dropped at the very start of post-processing instead of re-created.
CREATE TABLE IF NOT EXISTS processed_messages (
    message_id TEXT PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);