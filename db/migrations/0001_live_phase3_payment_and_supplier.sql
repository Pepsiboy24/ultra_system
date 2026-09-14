-- ============================================================
-- Live DB migration — Phase 3 payment integration + dropshipper
-- supplier-confirmation statuses.
--
-- Run ONCE against the production Supabase (SQL editor): "migration"
-- on the project. Each statement is guarded so a re-run is safe.
--
-- New status values: pending_supplier_confirmation, supplier_confirmed,
-- supplier_declined (dropshipper flow) + existing b2b/approved values.
-- ============================================================

-- 1) clients: Monnify settlement columns (per-client sub-account routing).
--    Onboarded via scripts/onboardClient.js --with-payment.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS settlement_account_number TEXT,
  ADD COLUMN IF NOT EXISTS settlement_bank_code     TEXT,
  ADD COLUMN IF NOT EXISTS settlement_email         TEXT,
  ADD COLUMN IF NOT EXISTS monnify_subaccount_code  TEXT;

-- 1b) clients: kitchen contact for 'restaurant' category orders. Receives the
--    kitchen ticket (notification only) after a customer confirms.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS kitchen_contact_phone TEXT;

-- 1c) clients: daily summary report. daily_summary_time is the HH:MM (24h,
--    server-local) the owner gets the day's order summary; the every-minute
--    cron only sends when it matches and the report for today hasn't been sent
--    yet (last_summary_sent_at <> today).
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS daily_summary_time  TEXT NOT NULL DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS last_summary_sent_at DATE;

-- 1c) products: menu/grouping field for restaurant stock-out alternatives.
--    Same-category (when set) or nearest-priced alternatives are suggested to
--    the customer instead of a flat rejection.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS category TEXT;

-- 2) orders: Monnify transaction reference returned by init-transaction.
--    Stored at checkout creation; matched by the payment webhook.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_transaction_reference TEXT;

-- 2b) orders: dedup guards for the supplier-response-timeout job (nudge at 1x
--    the window, escalation to the seller at 2x).
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS supplier_nudged_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS supplier_escalated_at  TIMESTAMPTZ;

-- 3) orders.status: extend the CHECK constraint with the dropshipper
--    supplier-confirmation states. `status` is TEXT + CHECK (not a native
--    enum), so we drop the EXISTING check constraint that sits on the
--    `status` column only (never the total_amount / payment_status checks)
--    and recreate it with the full allowed set.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.conrelid = 'orders'::regclass
       AND c.contype = 'c'
       AND a.attname = 'status'
  LOOP
    EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE orders
  ADD CONSTRAINT orders_status_check CHECK (
    status IN (
      'pending',
      'approved',
      'pending_ops_confirmation',
      'pending_supplier_confirmation',
      'supplier_confirmed',
      'supplier_declined',
      'ops_declined',
      'in_progress',
      'ready_for_customer',
      'rejected',
      'cancelled'
    )
  );

-- Sanity check (should return no rows once the migration matches the app):
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'orders'::regclass AND contype = 'c';