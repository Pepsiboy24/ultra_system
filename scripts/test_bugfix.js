/**
 * Short manual test for the product-matching bug fixes.
 *
 *   BUG 1 — mockHeuristicParse (cloudflare.js): "10 cartons of pineapple tea"
 *           must parse to product_name "Pineapple Tea", not "Cartons Of Pineapple Tea".
 *   BUG 2 — getProductByName() / getSupplierByName() (db.js): bidirectional
 *           substring matching, so a search term that CONTAINS the catalog name
 *           (e.g. "cartons of Earl Grey Blend") also resolves.
 *
 * Forces mock mode (no real Supabase/Cloudflare) so the run is deterministic.
 * 1) node scripts/seed.js  (seeds db/mock_db.json)
 * 2) node scripts/test_bugfix.js
 */

// Force mock modes BEFORE any module reads .env at require time.
process.env.SUPABASE_URL = 'https://your-project-id.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'your-supabase-service-role-key';
process.env.CLOUDFLARE_ACCOUNT_ID = 'your-cloudflare-account-id';
process.env.CLOUDFLARE_API_TOKEN = 'your-cloudflare-api-token';
process.env.MISTRAL_API_KEY = 'your-mistral-api-key';

const cloudflareClient = require('../src/config/cloudflare');
const db = require('../src/config/db');
const orderService = require('../src/services/orderService');

const MESSAGE = '10 cartons of pineapple tea from Golden Tea Co.';

(async () => {
  // --- BUG 1: extraction ---
  console.log('\n===== BUG 1: heuristic parse of the requested message =====');
  console.log(`Message: "${MESSAGE}"`);
  const parsed = await cloudflareClient.parseOrderMessage(MESSAGE);
  console.log('Parsed:', JSON.stringify(parsed, null, 2));
  const bug1Pass = parsed.items[0] && parsed.items[0].product_name === 'Pineapple Tea';
  console.log(`PASS: product_name is "Pineapple Tea" (was "Cartons Of Pineapple Tea")? ${bug1Pass}\n`);

  // --- BUG 2: bidirectional db lookups ---
  console.log('===== BUG 2: bidirectional getProductByName / getSupplierByName =====');
  const short = await db.getProductByName('Earl Grey');
  console.log(`getProductByName("Earl Grey")                       -> ${short ? short.name : null}  (search shorter than catalog name)`);

  const long = await db.getProductByName('cartons of Earl Grey Blend');
  console.log(`getProductByName("cartons of Earl Grey Blend")      -> ${long ? long.name : null}  (search CONTAINS catalog name)`);

  const longSup = await db.getSupplierByName('Supplier Golden Tea Co. on the line');
  console.log(`getSupplierByName("Supplier Golden Tea Co. on the line") -> ${longSup ? longSup.name : null}  (search CONTAINS catalog name)`);
  const bug2Pass = long && long.name === 'Earl Grey Blend' && longSup && longSup.name === 'Golden Tea Co.';
  console.log(`PASS: reverse-direction (search-contains-catalog) matches? ${bug2Pass}\n`);

  // --- End-to-end, exact message from the request ---
  console.log('===== Pipeline: exact requested message =====');
  const pipeline1 = await orderService.processOrderPipeline(parsed);
  console.log(`Status: ${pipeline1.order ? pipeline1.order.status : 'failed'} | Reason: ${pipeline1.reason || 'none'}`);
  console.log(`Note: "Pineapple Tea" is intentionally NOT in the seeded catalog, so this rejects on the cleaned name ("Pineapple Tea"), not "Cartons Of Pineapple Tea".\n`);

  // --- End-to-end, "cartons of" phrasing that maps to a real catalog product ---
  console.log('===== Pipeline: "cartons of" phrasing against a real catalog product =====');
  const parsed2 = await cloudflareClient.parseOrderMessage('10 cartons of Earl Grey from Golden Tea Co.');
  console.log('Parsed:', JSON.stringify(parsed2));
  const pipeline2 = await orderService.processOrderPipeline(parsed2);
  console.log(JSON.stringify({
    success: pipeline2.success,
    reason: pipeline2.reason || null,
    order: pipeline2.order ? {
      id: pipeline2.order.id,
      status: pipeline2.order.status,
      status_reason: pipeline2.order.status_reason,
      total_amount: pipeline2.order.total_amount,
      payment_link: pipeline2.order.payment_link
    } : null,
    items: pipeline2.items || []
  }, null, 2));
  const e2ePass = pipeline2.success === true && pipeline2.order.status === 'approved';
  console.log(`PASS: resolved against catalog (approved, no "Product not found")? ${e2ePass}`);
})();