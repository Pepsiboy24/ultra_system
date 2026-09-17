-- ============================================================
-- Live DB migration — Relay landing page lead capture.
--
-- Run ONCE against production Supabase (SQL editor / migration), or re-run
-- safely: every statement is guarded with IF NOT EXISTS.
--
-- Creates the `leads` table that POST /api/leads (src/controllers/
-- leadController.js) inserts into. Written only via the service_role key,
-- which bypasses RLS, so RLS is enabled with no user-facing policies.
-- ============================================================

CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name TEXT NOT NULL,
    whatsapp_number TEXT NOT NULL,
    business_category TEXT NOT NULL CHECK (business_category IN ('dropshipper', 'restaurant', 'b2b')),
    email TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_whatsapp_number ON leads (whatsapp_number);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
