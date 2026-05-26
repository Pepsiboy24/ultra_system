/**
 * Database Seeder for B2B Tea Order Pipeline
 * 
 * Sets up initial B2B suppliers and tea products.
 * If Supabase environment variables are missing or use default placeholders,
 * it seeds a local db/mock_db.json file to enable out-of-the-box local simulation.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

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

  console.log('🧹 Clearing existing orders and order_items...');
  // Delete order items then orders
  await supabase.from('order_items').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('orders').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  
  console.log('🧹 Clearing existing products and suppliers...');
  await supabase.from('products').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('suppliers').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  console.log('🌱 Seeding suppliers...');
  const { data: suppliers, error: supError } = await supabase
    .from('suppliers')
    .insert(seedSuppliers)
    .select();

  if (supError) {
    throw new Error(`Failed to seed suppliers: ${supError.message}`);
  }
  console.log(`✅ Successfully seeded ${suppliers.length} suppliers.`);

  console.log('🌱 Seeding products...');
  const { data: products, error: prodError } = await supabase
    .from('products')
    .insert(seedProducts)
    .select();

  if (prodError) {
    throw new Error(`Failed to seed products: ${prodError.message}`);
  }
  console.log(`✅ Successfully seeded ${products.length} products.`);
  console.log('🎉 Supabase Database Seeded Successfully!');
}

function seedMockDatabase() {
  console.log('💻 Supabase keys not set. Seeding local MOCK database...');
  
  const mockDir = path.join(__dirname, '../db');
  if (!fs.existsSync(mockDir)) {
    fs.mkdirSync(mockDir, { recursive: true });
  }

  // Create mock DB structure with generated string IDs for standard mapping
  const mockSuppliers = seedSuppliers.map((s, idx) => ({
    id: `sup-00${idx + 1}`,
    ...s,
    created_at: new Date().toISOString()
  }));

  const mockProducts = seedProducts.map((p, idx) => ({
    id: `prod-00${idx + 1}`,
    ...p,
    created_at: new Date().toISOString()
  }));

  const mockDb = {
    suppliers: mockSuppliers,
    products: mockProducts,
    orders: [],
    order_items: []
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
