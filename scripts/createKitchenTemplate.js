/**
 * Creates the kitchen-ticket WhatsApp template (UTILITY) via the Cloud API.
 * Same approach as scripts/createMessageTemplate.js.
 *
 * Reads from .env:
 *   WHATSAPP_ACCESS_TOKEN
 *   WHATSAPP_BUSINESS_ACCOUNT_ID   (the WABA ID, NOT the phone number ID)
 *
 * Usage:  node scripts/createKitchenTemplate.js
 *
 * After Meta approves it (status APPROVED), set these Worker secrets:
 *   npx wrangler secret put KITCHEN_TICKET_TEMPLATE        -> kitchen_new_order
 *   npx wrangler secret put KITCHEN_TICKET_TEMPLATE_LANG   -> en   (only if you change the language below)
 */

require('dotenv').config();
const GRAPH_API_VERSION = 'v25.0'; // matches src/services/whatsappService.js

async function main() {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

  if (!accessToken || !wabaId) {
    console.error('❌ Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID in .env first.');
    process.exit(1);
  }

  // The bot sends exactly 4 body variables, in this order:
  //   {{1}} short order id   {{2}} items   {{3}} total   {{4}} type + ETA (+ address)
  const template = {
    name: 'kitchen_new_order',
    language: 'en',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text:
          'Kitchen alert: you have a new order, number {{1}}. Items: {{2}}. ' +
          'Total: {{3}}. Details: {{4}}. Reply READY followed by the order number when it is done.',
        example: {
          body_text: [[
            'C3A85153',
            '2x Jollof Rice, 1x Chicken',
            'NGN 45,000.00',
            'PICKUP, ETA 20-25 min'
          ]]
        }
      }
    ]
  };

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates`;
  console.log(`\nCreating template "${template.name}" (${template.category}, ${template.language}) on WABA ${wabaId}...\n`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(template)
    });
    const data = await response.json();

    if (data.id) {
      console.log('✅ Template submitted!');
      console.log(`  Template ID : ${data.id}`);
      console.log(`  Status      : ${data.status || '(pending review)'}`);
      console.log(`  Category    : ${data.category}`);
      console.log('\n  Next: wait for APPROVED in WhatsApp Manager, then set the Worker secrets (see header).');
    } else {
      console.log('⚠️  Meta returned an error:\n');
      console.log(JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.error(`❌ Request failed: ${error.message}`);
    process.exit(1);
  }
}

main();
