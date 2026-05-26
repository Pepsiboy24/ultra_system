-- B2B Tea Order Pipeline Database Schema
-- Supabase / PostgreSQL DDL

-- Drop tables if they exist (for easy resetting/seeding during development)
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS suppliers CASCADE;

-- 1. Create Suppliers Table
CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    contact_email TEXT NOT NULL UNIQUE,
    contact_phone TEXT,
    credit_limit NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (credit_limit >= 0),
    outstanding_balance NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (outstanding_balance >= 0),
    can_request_credit BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Create Products Table
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    sku TEXT NOT NULL UNIQUE,
    price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Create Orders Table
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    status_reason TEXT,
    total_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (total_amount >= 0),
    payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed')),
    payment_link TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Create Order Items Table
CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(10, 2) NOT NULL CHECK (unit_price >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for performance & quick queries
CREATE INDEX idx_suppliers_name_lower ON suppliers (lower(name));
CREATE INDEX idx_products_name_lower ON products (lower(name));
CREATE INDEX idx_orders_supplier_id ON orders (supplier_id);
CREATE INDEX idx_order_items_order_id ON order_items (order_id);

-- Enable Row Level Security (RLS)
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

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
