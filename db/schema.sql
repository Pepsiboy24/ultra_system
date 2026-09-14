-- B2B Tea Order Pipeline Database Schema
-- Supabase / PostgreSQL DDL

-- Drop tables if they exist (for easy resetting/seeding during development)
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS suppliers CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS clients CASCADE;

-- 1. Create Clients Table
-- The tenant/business that installed this bot (e.g. "Moramjab Enterprises /
-- Ultra Tea"). DISTINCT from `suppliers` (who the client orders FROM) and from
-- `conversations.customer_phone` (customers messaging the bot to place orders).
-- The client's business_category drives how incoming customer orders get
-- routed later ('dropshipper' | 'restaurant' | 'b2b').
-- `business_category` is plain TEXT with an app-level allowed-values check
-- (NOT a Postgres ENUM), same reasoning as conversations.state: new categories
-- can be added without a migration.
-- Clients must be created BEFORE suppliers/products/orders: each of those
-- tables now carries a client_id foreign key so a second tenant's catalog can
-- never collide with the first.
CREATE TABLE clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name TEXT NOT NULL,
    whatsapp_number TEXT NOT NULL UNIQUE,
    business_category TEXT NOT NULL,
    -- Internal WhatsApp number that receives the B2B ops ticket (stock
    -- confirmation) after a customer confirms a b2b category order. May be
    -- null for categories that don't route to an ops contact.
    operations_contact_phone TEXT,
    -- WhatsApp number that receives the kitchen ticket for a 'restaurant'
    -- category order (item, quantity, modifiers, dine-in/delivery) after the
    -- customer confirms. Notification only — no reply handling. May be null.
    kitchen_contact_phone TEXT,
    -- Payment routing (Monnify sub-account model): each client settles to its
    -- OWN bank account. These are populated by scripts/onboardClient.js at
    -- onboarding time; monnify_subaccount_code is set once the provider
    -- sub-account has been created from the settlement details.
    settlement_account_number TEXT,
    settlement_bank_code TEXT,
    settlement_email TEXT,
    monnify_subaccount_code TEXT,
    -- Daily summary report: per-client HH:MM (24h, server-local) at which the
    -- business owner receives the day's order summary via WhatsApp, plus a
    -- dedup stamp of the last day the report was actually sent.
    daily_summary_time TEXT NOT NULL DEFAULT '09:00',
    last_summary_sent_at DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Create Suppliers Table
-- Scoped to a client: name/contact_email are unique PER CLIENT, so a second
-- tenant may add "Golden Tea Co." without colliding with the first.
CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    contact_phone TEXT,
    credit_limit NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (credit_limit >= 0),
    outstanding_balance NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (outstanding_balance >= 0),
    can_request_credit BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, name),
    UNIQUE (client_id, contact_email)
);

-- 3. Create Products Table
-- Scoped to a client: name/sku are unique PER CLIENT.
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sku TEXT NOT NULL,
    -- Menu/grouping field (e.g. 'Mains', 'Sides', 'Drinks'). Used by the
    -- restaurant stock-out fallback to suggest same-category alternatives.
    -- Nullable — client catalogs that don't categorize simply get
    -- nearest-priced alternatives instead.
    category TEXT,
    price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, name),
    UNIQUE (client_id, sku)
);

-- 4. Create Orders Table
-- `status` is TEXT with a CHECK constraint (a constrained-enum equivalent,
-- NOT a Postgres native ENUM). 'pending_ops_confirmation' is a B2B-flow state:
-- the order is confirmed by the customer but is awaiting stock confirmation
-- from the internal operations contact before it is treated as fully approved.
-- 'pending_supplier_confirmation' / 'supplier_confirmed' / 'supplier_declined'
-- are the DROPSHIPPER-flow states: after customer confirmation the order is
-- forwarded to the matched supplier, who replies YES/NO before fulfillment.
-- Adding/removing such states means editing this CHECK constraint.
-- client_id scopes the order to the tenant whose bot received it.
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'pending_ops_confirmation', 'pending_supplier_confirmation', 'supplier_confirmed', 'supplier_declined', 'ops_declined', 'in_progress', 'ready_for_customer', 'rejected', 'cancelled')),
    status_reason TEXT,
    total_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (total_amount >= 0),
    payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed')),
    payment_link TEXT,
    -- Monnify transaction reference returned by init-transaction. Used for
    -- server-side payment verification & reconciliation (paymentReference on
    -- the checkout is the order id).
    payment_transaction_reference TEXT,
    -- Hosted HTML invoice page (served by this app at /api/invoices/:id).
    invoice_url TEXT,
    -- Client-facing invoice snapshot fields, denormalized onto the order at
    -- creation so the hosted invoice / WhatsApp reply don't need to re-resolve
    -- the tenant business, delivery destination, or credit terms.
    business_name TEXT,
    delivery_location TEXT,
    payment_terms TEXT,
    -- Customer (payer) WhatsApp number, snapshot at confirmation so credit
    -- reminder messages can be sent to the right person.
    customer_phone TEXT,
    -- Dedup guard for the daily credit-reminder job: set to now() whenever a
    -- reminder is successfully sent. Milestones whose due date is <= this
    -- date are not re-sent, so re-running the job within the same day (or
    -- later) never duplicates a reminder.
    last_reminder_sent_at TIMESTAMPTZ,
    -- Dedup guards for the supplier-response-timeout job: whether a
    -- pending_supplier_confirmation order has already been nudged (1x window)
    -- and/or escalated to the seller (2x window), respectively.
    supplier_nudged_at TIMESTAMPTZ,
    supplier_escalated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Create Order Items Table
CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(10, 2) NOT NULL CHECK (unit_price >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Create Conversations Table
-- Internal conversation state machine: remembers each customer's pending,
-- parsed-but-unconfirmed order so the bot can pause and wait for confirmation
-- instead of creating orders immediately. `state` is plain TEXT with an
-- app-level enum check (NOT a Postgres ENUM) so future states (e.g.
-- 'awaiting_supplier') can be added without a migration.
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_phone TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'idle',
    pending_order_data JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for performance & quick queries
CREATE INDEX idx_clients_whatsapp_number ON clients (whatsapp_number);
CREATE INDEX idx_suppliers_client_id ON suppliers (client_id);
CREATE INDEX idx_suppliers_name_lower ON suppliers (lower(name));
CREATE INDEX idx_products_client_id ON products (client_id);
CREATE INDEX idx_products_name_lower ON products (lower(name));
CREATE INDEX idx_orders_client_id ON orders (client_id);
CREATE INDEX idx_orders_supplier_id ON orders (supplier_id);
CREATE INDEX idx_order_items_order_id ON order_items (order_id);
CREATE INDEX idx_conversations_customer_phone ON conversations (customer_phone);

-- Enable Row Level Security (RLS)
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

-- Conversations is an internal bot state table accessed only via the
-- service_role key (which bypasses RLS), so no client-facing policies are added.
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

-- Clients is also internal-only (tenant metadata), accessed only via the
-- service_role key — no client-facing policies are added.
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------
-- RLS POLICIES FOR SECURE CLIENT-SIDE / THIRD-PARTY ACCESS
-- ----------------------------------------------------

-- Products Policy: Anyone (authenticated or public/anon) can view products.
-- Modification is disabled by default for public roles.
CREATE POLICY select_products ON products 
    FOR SELECT TO public USING (true);

-- Suppliers Policy: Suppliers can view only their own profile details.
-- Validated against the contact_email associated with their JWT token.
CREATE POLICY select_supplier ON suppliers 
    FOR SELECT TO authenticated 
    USING (auth.jwt() ->> 'email' = contact_email);

-- Orders Policy: Suppliers can view only their own orders.
CREATE POLICY select_orders ON orders 
    FOR SELECT TO authenticated 
    USING (supplier_id IN (
        SELECT id FROM suppliers WHERE auth.jwt() ->> 'email' = contact_email
    ));

-- Order Items Policy: Suppliers can view items of their own orders only.
CREATE POLICY select_order_items ON order_items 
    FOR SELECT TO authenticated 
    USING (order_id IN (
        SELECT id FROM orders WHERE supplier_id IN (
            SELECT id FROM suppliers WHERE auth.jwt() ->> 'email' = contact_email
        )
    ));
