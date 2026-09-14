/**
 * One-off script to create a WhatsApp Business message template via the
 * Cloud API. Created for Meta App Review demo video recording.
 *
 * Reads from .env:
 *   WHATSAPP_ACCESS_TOKEN           (existing — same token used by whatsappService)
 *   WHATSAPP_BUSINESS_ACCOUNT_ID    (new — WABA ID from Meta dashboard, NOT the phone number ID)
 *
 * Usage:
 *   node scripts/createMessageTemplate.js
 */

require('dotenv').config();
const GRAPH_API_VERSION = 'v25.0'; // matches src/services/whatsappService.js

async function main() {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

  if (!accessToken) {
    console.error('❌ WHATSAPP_ACCESS_TOKEN is not set in .env');
    process.exit(1);
  }
  if (!wabaId) {
    console.error('❌ WHATSAPP_BUSINESS_ACCOUNT_ID is not set in .env');
    console.error('   Find it in: Meta App Dashboard → WhatsApp → Getting Started (top of page)');
    process.exit(1);
  }

  const template = {
    name: 'order_confirmed_v3',
    language: 'en',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Hi {{1}}, your order for {{2}} has been confirmed. Total: NGN {{3}}. Thank you for your business!',
        example: {
          body_text: [['Amram', 'Zen-Tang White Tea 3kg', '45,000.00']]
        }
      }
    ]
  };

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates`;

  console.log('\n--- Creating WhatsApp message template ---');
  console.log(`  WABA ID    : ${wabaId}`);
  console.log(`  Template   : ${template.name}`);
  console.log(`  Category   : ${template.category}`);
  console.log(`  Language   : ${template.language}`);
  console.log(`  API URL    : ${url}`);
  console.log('-------------------------------------------\n');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(template)
    });

    const data = await response.json();

    // Meta's Graph API returns only { id, status, category } on template
    // creation — name and language are not included in the response body,
    // so they're printed from the request payload below.
    if (data.id) {
      console.log('✅ Template created successfully!\n');
      console.log(`  Template ID : ${data.id}`);
      console.log(`  Status      : ${data.status || '(pending review)'}`);
      console.log(`  Name        : ${template.name}`);     // not in Meta's response body; read from request
      console.log(`  Category    : ${data.category}`);      // only this, id, status are returned
      console.log(`  Language    : ${template.language}`);   // not in Meta's response body; read from request
      if (data.status === 'PENDING') {
        console.log('\n  ⏳ Pending Meta review — usually a few minutes to a few hours.');
      } else if (data.status === 'APPROVED') {
        console.log('\n  ✅ Approved and ready to send.');
      }
    } else {
      console.log('⚠️  API returned an error response:\n');
      console.log(JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.error(`❌ Request failed: ${error.message}`);
    process.exit(1);
  }
}

main();
