/**
 * Onboard a second client (tenant) without touching the database by hand.
 *
 * Creates a clients row plus the client's "empty starting catalog" — the
 * per-client "Unknown Supplier" audit placeholder supplier (same structure the
 * seed gives the default client, so rejected orders always have a valid,
 * tenant-scoped FK target). No real suppliers/products are created; those get
 * added later per-client.
 *
 * Payment routing (optional): pass --with-payment (or any --settlement-* flag)
 * to also collect the client's settlement bank details and create their
 * Monnify SUB-ACCOUNT, so money settles to THIS client's bank account — a
 * separate sub-account per tenant, never a shared one. With MONNIFY_* creds
 * unset/placeholder the sub-account is simulated (mock mode).
 *
 * Usage:
 *   node scripts/onboardClient.js \
 *     --name "Lagos Tea Wholesale" \
 *     --phone "2349090000001" \
 *     --category b2b \
 *     --ops "234912345678" \
 *     --summary-time "08:00" \
 *     --with-payment \
 *     --settlement-account "0211319282" \
 *     --settlement-bank "058" \
 *     --settlement-email "finance@lagostea.com"
 *
 * TIMEZONE NOTE for --summary-time: the value is HH:MM UTC (the Worker's clock
 * is UTC). For Nigerian/WAT clients (UTC+1, no DST) enter the client's intended
 * wall-clock time minus 1 hour — e.g. 08:00 delivers the summary at 9am WAT.
 *
 * Any missing required value falls back to an interactive prompt.
 * Runs against the real Supabase DB when .env has live keys, otherwise the
 * local mock db/mock_db.json.
 */

require('dotenv').config();
const readline = require('readline');
const db = require('../src/config/db');
const paymentService = require('../src/services/paymentService');

const VALID_CATEGORIES = ['b2b', 'restaurant', 'dropshipper'];
const USAGE = `
Usage:
  node scripts/onboardClient.js \\
    --name "Business Name" \\
    --phone "2349090000001" \\
    --category b2b|restaurant|dropshipper \\
    --ops "234912345678"         (optional operations contact for b2b tickets)
    --summary-time "08:00"       (per-client daily summary send time, HH:MM UTC —
                                  enter intended WAT time minus 1h, e.g. 08:00
                                  for a 9am WAT summary. Default: 09:00)

  Optional payment routing (per-client Monnify sub-account):
    --with-payment               (enable the payment setup step)
    --settlement-account "0211319282"   (client's settlement bank account no.)
    --settlement-bank "058"             (3-digit bank code, e.g. GTBank=058)
    --settlement-email "finance@acme.com"

Example:
  node scripts/onboardClient.js --name "Lagos Tea Wholesale" --phone "2349090000001" --category b2b
  node scripts/onboardClient.js --name "Lagos Tea Wholesale" --phone "2349090000001" --category b2b --with-payment

Missing values fall back to interactive prompts. --help prints this message.
`;

function parseArgs(argv) {
  const args = { name: null, phone: null, category: null, ops: null, summaryTime: null, withPayment: false, settlementAccount: null, settlementBank: null, settlementEmail: null };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help') return { help: true, args };
    if (key === '--with-payment') { args.withPayment = true; continue; }
    if (key.startsWith('--')) {
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) {
        const flag = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (flag in args) args[flag] = value;
      }
    }
  }
  return { help: false, args };
}

function prompt(rl, question, validate = null) {
  return new Promise((resolve) => {
    const ask = (q) => {
      rl.question(q, (answer) => {
        const trimmed = String(answer || '').trim();
        if (validate && !validate(trimmed)) {
          console.log(`  ✗ Invalid: "${trimmed}".`);
          return ask(q);
        }
        resolve(trimmed || null);
      });
    };
    ask(question);
  });
}

async function main() {
  const { help, args } = parseArgs(process.argv);

  if (help) {
    console.log(USAGE);
    return;
  }

  console.log(`⚡ Onboarding client into ${db.isMock ? 'LOCAL MOCK' : 'SUPABASE (LIVE)'} database...`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const name = args.name || await prompt(rl, 'Business name: ', (v) => v && v.length > 0);
    const phone = (args.phone || await prompt(rl, 'WhatsApp Business number (e.g. 2349090000001): ', (v) => v && v.replace(/\D/g, '').length >= 7)).replace(/\D/g, '');
    const category = (args.category || await prompt(rl, 'Business category (b2b | restaurant | dropshipper) [b2b]: ', (v) => !v || VALID_CATEGORIES.includes(v || 'b2b'))) || 'b2b';
    let ops = args.ops;
    if (ops === null && category === 'b2b') {
      ops = await prompt(rl, 'Operations contact phone (receives b2b stock-confirmation tickets, optional): ');
    }
    if (ops) ops = ops.replace(/\D/g, '');

    // UTC convention: Workers clock is UTC, so ask for the UTC-equivalent of the
    // client's desired wall-clock time (WAT = UTC+1, so intended time minus 1h).
    const summaryTime = (args.summaryTime || await prompt(
      rl,
      'Daily summary time HH:MM UTC (enter 08:00 for 9am WAT) [09:00]: ',
      (v) => !v || /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
    )) || '09:00';

    if (!VALID_CATEGORIES.includes(category)) {
      console.error(`❌ category must be one of: ${VALID_CATEGORIES.join(', ')}`);
      process.exit(1);
    }

    const existing = await db.getClientByPhone(phone);
    if (existing) {
      console.error(`❌ A client already exists for WhatsApp number ${phone}: "${existing.business_name}" (client_id ${existing.id}). Aborting to avoid a duplicate tenant.`);
      process.exit(1);
    }

    // Optional payment setup: collect the client's settlement bank details
    // (needed to create their Monnify sub-account for 100%-split settlement).
    const wantsPayment = args.withPayment || args.settlementAccount || args.settlementBank || args.settlementEmail;
    const payment = {};
    if (wantsPayment) {
      console.log('💳 Collecting settlement bank details (per-client Monnify sub-account)...');
      payment.settlement_account_number = (args.settlementAccount || await prompt(rl, 'Settlement bank account number: ', (v) => v && v.replace(/\D/g, '').length >= 10)).replace(/\D/g, '');
      payment.settlement_bank_code = args.settlementBank || await prompt(rl, 'Settlement bank code (3-digit, e.g. 058): ', (v) => /^\d{3}$/.test(v));
      payment.settlement_email = args.settlementEmail || await prompt(rl, 'Settlement email (receives payout notifications): ', (v) => v && v.includes('@'));
    }

    console.log(`🌱 Creating client "${name}" (category: ${category})...`);
    const client = await db.createClient({
      business_name: name,
      whatsapp_number: phone,
      business_category: category,
      operations_contact_phone: ops || null,
      daily_summary_time: summaryTime,
      ...(wantsPayment ? payment : {})
    });

    console.log('🌱 Creating empty starting catalog (per-client "Unknown Supplier" audit row)...');
    const placeholder = await db.createPlaceholderSupplier(client.id);

    // Create the Monnify sub-account when payment setup was requested. Simulated
    // in mock mode; real against Monnify when MONNIFY_* env vars are configured.
    let subaccountCode = null;
    if (wantsPayment) {
      console.log('💳 Creating Monnify sub-account for this client...');
      subaccountCode = await paymentService.ensureClientSubaccount(client.id);
      if (!subaccountCode) {
        console.warn('⚠️ Could not create a Monnify sub-account right now (check MONNIFY_API_KEY/SECRET_KEY/CONTRACT_CODE). Settlement details were saved; the sub-account will be created automatically on the first paid order.');
      }
    }

    console.log('==================================================');
    console.log('✅ Client onboarded successfully!');
    console.log('--------------------------------------------------');
    console.log(`  client_id                  : ${client.id}`);
    console.log(`  business_name              : ${client.business_name}`);
    console.log(`  business_category          : ${client.business_category}`);
    console.log(`  whatsapp_number            : ${client.whatsapp_number}`);
    console.log(`  ops contact              : ${client.operations_contact_phone || '(none)'}`);
    console.log(`  daily_summary_time (UTC) : ${client.daily_summary_time || '09:00'}  (enter WAT time -1h, e.g. 08:00 for 9am WAT)`);
    console.log(`  placeholder supplier id    : ${placeholder.id}`);
    if (wantsPayment) {
      console.log(`  settlement_account_number  : ${payment.settlement_account_number}`);
      console.log(`  settlement_bank_code       : ${payment.settlement_bank_code}`);
      console.log(`  settlement_email           : ${payment.settlement_email}`);
      console.log(`  monnify sub-account code   : ${subaccountCode || '(pending — set MONNIFY_* env)'}`);
    }
    console.log('--------------------------------------------------');
    console.log('Next steps for a real second client:');
    console.log('  1. Register this WhatsApp number as the bot\'s webhook number in Meta;');
    console.log('     the webhook metadata.display_phone_number must equal the');
    console.log('     whatsapp_number above for tenant resolution.');
    console.log('  2. Add this client\'s suppliers & products (all catalog lookups are');
    console.log('     client_id-scoped, so names may overlap with other tenants).');
    console.log('  3. Rejected/unmatched orders are audit-trailed against THIS client\'s');
    console.log('     placeholder supplier, keeping the tenant isolated.');
    if (wantsPayment) {
      console.log('  4. Confirmed orders for this client now get Monnify checkout links that');
      console.log('     settle 100% to the sub-account above (their own bank account).');
    }
    console.log('==================================================');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error('❌ Onboarding failed:', error.message);
  process.exit(1);
});