/**
 * Database Seeder for B2B Tea Order Pipeline
 * 
 * Sets up initial B2B suppliers and tea products.
 * If Supabase environment variables are missing or use default placeholders,
 * it seeds a local db/mock_db.json file to enable out-of-the-box local simulation.
 *
 * Multi-tenant: every supplier, product and placeholder row is tagged with the
 * seeded client's client_id so catalog lookups are scoped per tenant. Clients
 * are seeded FIRST (suppliers/products carry a client_id foreign key).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { UNKNOWN_SUPPLIER_ID } = require('../src/config/db');

// Internal placeholder supplier used to record rejected orders whose supplier
// could not be resolved (orders.supplier_id is NOT NULL -> audit trail).
// Per-client: seeded once per tenant. A second client would need its own row.
const placeholderSupplier = {
  id: UNKNOWN_SUPPLIER_ID,
  name: 'Unknown Supplier',
  contact_email: 'unknown@tea-pipeline.internal',
  contact_phone: null,
  credit_limit: 0.00,
  outstanding_balance: 0.00,
  can_request_credit: false
};

// Mock data configuration
const seedSuppliers = [
  {
    name: 'Golden Tea Co.',
    contact_email: 'contact@goldentea.com',
    contact_phone: '+15551234567',
    credit_limit: 5000.00,
    outstanding_balance: 0.00,
    can_request_credit: true
  },
  {
    name: 'Darjeeling Imports',
    contact_email: 'info@darjeeling.com',
    contact_phone: '+15559876543',
    credit_limit: 2000.00,
    outstanding_balance: 1500.00,
    can_request_credit: true
  },
  {
    name: 'Matcha Supreme',
    contact_email: 'orders@matchasupreme.com',
    contact_phone: '+15553334444',
    credit_limit: 10000.00,
    outstanding_balance: 0.00,
    can_request_credit: true
  }
];

const seedProducts = [
  {
    name: 'Earl Grey Blend',
    sku: 'TG-EG-01',
    price: 15.00,
    stock_quantity: 100
  },
  {
    name: 'Chamomile Fields',
    sku: 'TG-CF-02',
    price: 12.50,
    stock_quantity: 50
  },
  {
    name: 'Ceremonial Matcha',
    sku: 'TG-CM-03',
    price: 45.00,
    stock_quantity: 20
  },
  {
    name: 'English Breakfast',
    sku: 'TG-EB-04',
    price: 10.00,
    stock_quantity: 200
  }
];

// The single tenant that installed this bot (single-tenant for now). The
// whatsapp_number is a placeholder for the business's real bot number.
// operations_contact_phone receives the B2B ops ticket (stock confirmation)
// after a b2b category order is confirmed.
const seedClients = [
  {
    business_name: 'Moramjab Enterprises / Ultra Tea',
    whatsapp_number: '2348000000001',
    business_category: 'b2b',
    operations_contact_phone: '2348111111111',
    // Payment routing fields; populated by scripts/onboardClient.js when a
    // client is onboarded with settlement bank details (Monnify sub-account).
    settlement_account_number: null,
    settlement_bank_code: null,
    settlement_email: null,
    monnify_subaccount_code: null
  }
];

function isSupabaseConfigured() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  return (
    url && 
    key && 
    url !== 'https://your-project-id.supabase.co' && 
    key !== 'your-supabase-service-role-key' &&
    url.startsWith('https://')
  );
}

async function seedRealSupabase() {
  console.log('🔗 Connecting to Supabase database...');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  console.log('🧹 Clearing existing orders, items, clients, catalog...');
  // Delete in FK-safe order (children first, clients last).
  await supabase.from('order_items').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('orders').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  console.log('🗨️ Ensuring conversations table exists...');
  const { error: convCheckError } = await supabase
    .from('conversations')
    .select('id')
    .limit(1);

  if (convCheckError) {
    // db/schema.sql is the source of truth for DDL (supabase-js can't run raw
    // DDL); fail soft so seeding still works if the table is applied later.
    console.warn(`⚠️ Conversations table not found (${convCheckError.message}). Apply db/schema.sql to create it; skipping conversation reset.`);
  } else {
    console.log('🗨️ Clearing existing conversations...');
    await supabase.from('conversations').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  }
  
  console.log('🧹 Clearing existing products, suppliers and clients...');
  await supabase.from('products').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('suppliers').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  console.log('📋 Ensuring clients table exists...');
  const { error: clientCheckError } = await supabase
    .from('clients')
    .select('id')
    .limit(1);

  let clientId = null;
  if (clientCheckError) {
    // db/schema.sql is the source of truth for DDL (supabase-js can't run raw
    // DDL); fail soft so seeding still works if the table is applied later.
    console.warn(`⚠️ Clients table not found (${clientCheckError.message}). Apply db/schema.sql to create it; supplier/product seeding requires it.`);
  } else {
    console.log('📋 Clearing existing clients...');
    await supabase.from('clients').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    console.log('🌱 Seeding client (tenant)...');
    const { data: clients, error: clientError } = await supabase
      .from('clients')
      .insert(seedClients)
      .select();

    if (clientError) {
      throw new Error(`Failed to seed clients: ${clientError.message}`);
    }
    clientId = clients[0].id;
    console.log(`✅ Successfully seeded ${clients.length} client(s): "${clients[0].business_name}" (${clients[0].business_category}) -> client_id ${clientId}`);
  }

  if (!clientId) {
    console.warn('⚠️ No client seeded — skipping supplier/product/placeholder seeding (schema may not be applied yet).');
  } else {
    console.log('🌱 Seeding suppliers (scoped to client)...');
    const { data: suppliers, error: supError } = await supabase
      .from('suppliers')
      .insert(seedSuppliers.map(s => ({ ...s, client_id: clientId })))
      .select();

    if (supError) {
      throw new Error(`Failed to seed suppliers: ${supError.message}`);
    }
    console.log(`✅ Successfully seeded ${suppliers.length} suppliers.`);

    console.log('🌱 Seeding system placeholder supplier (Unknown Supplier)...');
    const { data: placeholder, error: phError } = await supabase
      .from('suppliers')
      .insert([{ ...placeholderSupplier, client_id: clientId }])
      .select();

    if (phError) {
      throw new Error(`Failed to seed placeholder supplier: ${phError.message}`);
    }
    console.log(`✅ Successfully seeded placeholder supplier "${placeholder[0].name}".`);

    console.log('🌱 Seeding products (scoped to client)...');
    const { data: products, error: prodError } = await supabase
      .from('products')
      .insert(seedProducts.map(p => ({ ...p, client_id: clientId })))
      .select();

    if (prodError) {
      throw new Error(`Failed to seed products: ${prodError.message}`);
    }
    console.log(`✅ Successfully seeded ${products.length} products.`);
  }

  console.log('🎉 Supabase Database Seeded Successfully!');
}

function seedMockDatabase() {
  console.log('💻 Supabase keys not set. Seeding local MOCK database...');
  
  const mockDir = path.join(__dirname, '../db');
  if (!fs.existsSync(mockDir)) {
    fs.mkdirSync(mockDir, { recursive: true });
  }

  // Create mock DB structure with generated string IDs for standard mapping.
  // Clients first; every catalog row is tagged with the seeded client id.
  const mockClients = seedClients.map((c, idx) => ({
    id: `cli-00${idx + 1}`,
    ...c,
    created_at: new Date().toISOString()
  }));
  const MOCK_CLIENT_ID = mockClients[0].id;

  const mockSuppliers = seedSuppliers.map((s, idx) => ({
    id: `sup-00${idx + 1}`,
    client_id: MOCK_CLIENT_ID,
    ...s,
    created_at: new Date().toISOString()
  }));

  const mockProducts = seedProducts.map((p, idx) => ({
    id: `prod-00${idx + 1}`,
    client_id: MOCK_CLIENT_ID,
    ...p,
    created_at: new Date().toISOString()
  }));

  mockSuppliers.push({
    ...placeholderSupplier,
    client_id: MOCK_CLIENT_ID,
    created_at: new Date().toISOString()
  });

  const mockDb = {
    suppliers: mockSuppliers,
    products: mockProducts,
    orders: [],
    order_items: [],
    conversations: [],
    clients: mockClients
  };

  const dbPath = path.join(mockDir, 'mock_db.json');
  fs.writeFileSync(dbPath, JSON.stringify(mockDb, null, 2), 'utf8');
  
  console.log(`✅ Successfully created local mock database at: ${dbPath}`);
  console.log(`🌱 Seeded ${mockSuppliers.length} mock suppliers.`);
  console.log(`🌱 Seeded ${mockProducts.length} mock products.`);
  console.log('🎉 Mock Database Seeded Successfully!');
}

async function run() {
  try {
    if (isSupabaseConfigured()) {
      await seedRealSupabase();
    } else {
      seedMockDatabase();
    }
  } catch (error) {
    console.error('❌ Seeding failed:', error.message);
    process.exit(1);
  }
}

run();