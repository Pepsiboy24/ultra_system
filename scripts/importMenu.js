/**
 * Import / refresh a restaurant's menu from a CSV file.
 *
 * CSV header (first line):  name,category,price,available
 *   - available is optional: yes/no (default yes)
 *   - see scripts/menu_template.csv
 *
 * Usage:
 *   node scripts/importMenu.js --client <client-uuid | business WhatsApp number> --file menu.csv [--dry-run]
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
 * (a .env file works, or put them in front of the command).
 *
 * Existing items (same name, ignoring upper/lower case) are UPDATED; new items
 * are ADDED. Nothing is ever deleted — use the OUT command (or set
 * available=no) to take an item off the menu.
 */
require('dotenv').config();
const fs = require('fs');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) rows.push(row);
  return rows;
}

function toMenuItems(rows) {
  if (rows.length < 2) throw new Error('The CSV needs a header line and at least one item.');
  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  if (col('name') < 0 || col('price') < 0) throw new Error('The header must contain at least: name,price');
  const items = [];
  const problems = [];
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const name = (r[col('name')] || '').trim();
    const price = Number(String(r[col('price')] || '').replace(/[₦,\s]/g, ''));
    const category = col('category') >= 0 ? (r[col('category')] || '').trim() || null : null;
    const avail = col('available') >= 0 ? String(r[col('available')] || 'yes').trim().toLowerCase() : 'yes';
    if (!name) return problems.push(`line ${line}: missing name`);
    if (!Number.isFinite(price) || price <= 0) return problems.push(`line ${line}: "${name}" has an invalid price`);
    items.push({ name, category, price, is_available: !['no', 'n', 'false', '0'].includes(avail) });
  });
  return { items, problems };
}

function slugSku(name) {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'ITEM';
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.client || !args.file) {
    console.log('Usage: node scripts/importMenu.js --client <client-uuid | WhatsApp number> --file menu.csv [--dry-run]');
    process.exit(1);
  }
  const { items, problems } = toMenuItems(parseCsv(fs.readFileSync(args.file, 'utf8')));
  if (problems.length) {
    console.error('❌ Fix these CSV problems first:\n  ' + problems.join('\n  '));
    process.exit(1);
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (in .env or in front of the command).');
    process.exit(1);
  }
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Resolve the client by UUID or by business WhatsApp number.
  const { data: clients, error: cErr } = await supabase.from('clients').select('id, business_name, whatsapp_number, business_category');
  if (cErr) throw cErr;
  const wanted = String(args.client).replace(/\D/g, '');
  const client = clients.find(c => c.id === args.client) ||
    clients.find(c => wanted && String(c.whatsapp_number || '').replace(/\D/g, '') === wanted);
  if (!client) { console.error(`❌ No client matches "${args.client}".`); process.exit(1); }
  if (client.business_category !== 'restaurant') {
    console.error(`❌ ${client.business_name} is "${client.business_category}", not a restaurant. Refusing to import.`);
    process.exit(1);
  }

  const { data: existing, error: eErr } = await supabase.from('products').select('id, name').eq('client_id', client.id);
  if (eErr) throw eErr;
  const byName = new Map((existing || []).map(p => [p.name.trim().toLowerCase(), p]));

  let added = 0, updated = 0;
  console.log(`\nMenu import for ${client.business_name} (${items.length} items)${args.dryRun ? ' — DRY RUN, nothing will be saved' : ''}\n`);
  for (const item of items) {
    const match = byName.get(item.name.toLowerCase());
    if (match) {
      console.log(`  ~ update  ${item.name}  ₦${item.price}${item.is_available ? '' : '  (unavailable)'}`);
      if (!args.dryRun) {
        const { error } = await supabase.from('products')
          .update({ category: item.category, price: item.price, is_available: item.is_available })
          .eq('id', match.id).eq('client_id', client.id);
        if (error) throw error;
      }
      updated++;
    } else {
      console.log(`  + add     ${item.name}  ₦${item.price}${item.is_available ? '' : '  (unavailable)'}`);
      if (!args.dryRun) {
        const { error } = await supabase.from('products').insert({
          client_id: client.id, name: item.name, sku: slugSku(item.name),
          category: item.category, price: item.price, stock_quantity: 0, is_available: item.is_available
        });
        if (error) throw error;
      }
      added++;
    }
  }
  console.log(`\n✅ Done: ${added} added, ${updated} updated.${args.dryRun ? ' (dry run — nothing saved)' : ''}`);
}

if (require.main === module) {
  main().catch(err => { console.error('❌ Import failed:', err.message || err); process.exit(1); });
}
module.exports = { parseCsv, toMenuItems, slugSku };
