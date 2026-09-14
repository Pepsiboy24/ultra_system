/**
 * Placeholder Supplier Seeder
 *
 * One-off (re-runnable) upsert of the internal "Unknown Supplier" placeholder
 * row into a real Supabase database. Resolves the orders.supplier_id FK issue
 * for orders whose supplier could not be matched, WITHOUT the full wipe that
 * scripts/seed.js performs.
 *
 * Safe to re-run: uses INSERT ... ON CONFLICT (id) DO UPDATE, touches ONLY the
 * placeholder supplier row and nothing else.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { UNKNOWN_SUPPLIER_ID } = require('../src/config/db');

// MUST stay in sync with the placeholder inserted by scripts/seed.js:17-25.
const placeholderSupplier = {
  id: UNKNOWN_SUPPLIER_ID,
  name: 'Unknown Supplier',
  contact_email: 'unknown@tea-pipeline.internal',
  contact_phone: null,
  credit_limit: 0.00,
  outstanding_balance: 0.00,
  can_request_credit: false
};

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

async function run() {
  if (!isSupabaseConfigured()) {
    console.error('❌ Real Supabase keys not detected. This script only runs against a real Supabase project (it must never touch the local mock DB).');
    console.error('   Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (or the environment) and re-run.');
    process.exit(1);
  }

  console.log('🔗 Connecting to Supabase database...');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  console.log('🌱 Upserting placeholder supplier (Unknown Supplier)...');
  const { data, error } = await supabase
    .from('suppliers')
    .upsert(placeholderSupplier, { onConflict: 'id' })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to upsert placeholder supplier: ${error.message}`);
  }

  console.log(`✅ Placeholder supplier upserted: ${data.id} — "${data.name}"`);
  console.log('🎉 Placeholder Supplier Seeder Completed Successfully!');
}

run().catch(error => {
  console.error('❌ Seeding failed:', error.message);
  process.exit(1);
});