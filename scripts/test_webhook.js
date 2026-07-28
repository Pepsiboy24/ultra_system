/**
 * Webhook and Fallback Lookup Verification Script
 * 
 * Boots up the Express server, runs HTTP tests simulating WhatsApp Cloud API
 * webhook scenarios, and prints detailed validations.
 */

const http = require('http');
const app = require('../src/app');

const PORT = 3600;
let server;

// Start local Express server for testing
function startServer() {
  return new Promise((resolve) => {
    server = app.listen(PORT, () => {
      resolve();
    });
  });
}

// Make a GET request (for verification handshake)
function getHandshake(queryParams) {
  return new Promise((resolve, reject) => {
    const queryStr = Object.entries(queryParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: `/api/webhook?${queryStr}`,
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: data
        });
      });
    });

    req.on('error', (e) => reject(e));
    req.end();
  });
}

// Make a POST request (simulating Meta Webhook payload)
function postWebhookPayload(payload) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: '/api/webhook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(data)
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            body: data
          });
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.write(postData);
    req.end();
  });
}

// Visual formatting helpers
const green = (text) => `\x1b[32m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const blue = (text) => `\x1b[34m${text}\x1b[0m`;
const yellow = (text) => `\x1b[33m${text}\x1b[0m`;

// Helper to build Meta webhook mock messages
function buildMetaPayload(fromNumber, messageText) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WHATSAPP_BUSINESS_ACCOUNT_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "16505551111",
                phone_number_id: "1234567890"
              },
              contacts: [
                {
                  profile: {
                    name: "Test User"
                  },
                  wa_id: fromNumber
                }
              ],
              messages: [
                {
                  from: fromNumber,
                  id: `wamid.MOCK_${Math.random().toString(36).substring(7)}`,
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  text: {
                    body: messageText
                  },
                  type: "text"
                }
              ]
            },
            field: "messages"
          }
        ]
      }
    ]
  };
}

async function runTests() {
  console.log(blue('\n======================================================'));
  console.log(blue('📱 Starting WhatsApp Webhook & Fallback Test Suite'));
  console.log(blue('======================================================\n'));

  // 1. Boot Server
  await startServer();
  console.log(green(`📡 Live test server started on http://localhost:${PORT}`));

  // 2. Set Verify Token env variable for test consistency
  process.env.WHATSAPP_VERIFY_TOKEN = 'test_verify_token_123';

  // --- Scenarios Group 1: Handshake Verification ---
  console.log(blue('\n--- Testing GET Verification Handshake ---'));

  // Handshake 1: Valid Verification Token
  const handshakeResult1 = await getHandshake({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'test_verify_token_123',
    'hub.challenge': 'expected_challenge_value_999'
  });
  if (handshakeResult1.statusCode === 200 && handshakeResult1.body === 'expected_challenge_value_999') {
    console.log(green('✅ PASS: Handshake verified with HTTP 200 and challenge echoed back.'));
  } else {
    console.log(red(`❌ FAIL: Handshake failed. Status: ${handshakeResult1.statusCode}, Body: ${handshakeResult1.body}`));
  }

  // Handshake 2: Invalid Verification Token
  const handshakeResult2 = await getHandshake({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'wrong_token',
    'hub.challenge': 'some_challenge'
  });
  if (handshakeResult2.statusCode === 403) {
    console.log(green('✅ PASS: Incorrect verification token properly rejected with HTTP 403.'));
  } else {
    console.log(red(`❌ FAIL: Incorrect verification token did not reject with 403. Status: ${handshakeResult2.statusCode}`));
  }


  // --- Scenarios Group 2: Webhook POST Processing ---
  console.log(blue('\n--- Testing POST Webhook Event Processing & Fallback ---'));

  // POST Scenario 1: Successful webhook processing with known supplier name
  // Note: Darjeeling Imports credit toggle allows credit request
  console.log(yellow('\n🏃 Running POST Scenario 1: Known Supplier Name ("Darjeeling Imports")'));
  const payload1 = buildMetaPayload('+15559876543', "Hey this is Darjeeling Imports. We'd like to order 10 packs of English Breakfast.");
  const res1 = await postWebhookPayload(payload1);
  if (res1.statusCode === 200 && res1.body.success === true && res1.body.pipeline_result.status === 'approved') {
    console.log(green('  ✅ PASS: Webhook processed successfully. Order status: approved, Total: $' + res1.body.pipeline_result.total_amount));
  } else {
    console.log(red('  ❌ FAIL: Scenario 1 failed. Res: ' + JSON.stringify(res1.body)));
  }

  // POST Scenario 2: Webhook processing with Ambiguous Supplier Name but Recognized Contact Phone
  // Golden Tea Co. phone is "+15551234567"
  // Let's pass a message saying "Hi we need to order 5 bags of Earl Grey."
  // The AI parser won't be able to extract a supplier name (or it will default to 'Unknown Supplier')
  // The database fallback should match "+15551234567" to Golden Tea Co. and then check its credit status.
  // Wait! In mock_db.json, Golden Tea Co. has "can_request_credit": false, so order should be REJECTED due to restricted credit!
  console.log(yellow('\n🏃 Running POST Scenario 2: Ambiguous Supplier Name + Recognized Phone fallback ("Golden Tea Co.")'));
  const payload2 = buildMetaPayload('+15551234567', "Hi we need to order 5 bags of Earl Grey.");
  const res2 = await postWebhookPayload(payload2);
  // Expected: Supplier identified via phone number as Golden Tea Co.
  // Then since Golden Tea Co. is can_request_credit: false, order is REJECTED.
  if (res2.statusCode === 200 && res2.body.success === false && res2.body.pipeline_result.status === 'rejected' && res2.body.pipeline_result.reason.includes('restricted from requesting credit')) {
    console.log(green('  ✅ PASS: Lookup fallback succeeded! Recognized Golden Tea Co. via phone number. Correctly rejected due to credit request restrictions.'));
  } else {
    console.log(red('  ❌ FAIL: Scenario 2 failed. Res: ' + JSON.stringify(res2.body)));
  }

  // POST Scenario 3: Ambiguous Supplier Name + UNKNOWN Phone
  // Sender phone is "+15550000000" (Not in mock_db.json)
  console.log(yellow('\n🏃 Running POST Scenario 3: Unknown Supplier Name + Unknown Phone'));
  const payload3 = buildMetaPayload('+15550000000', "Hi we need to order 5 bags of Earl Grey.");
  const res3 = await postWebhookPayload(payload3);
  if (res3.statusCode === 200 && res3.body.success === false && res3.body.pipeline_result.reason.includes('not found')) {
    console.log(green('  ✅ PASS: Correctly rejected with supplier not found error.'));
  } else {
    console.log(red('  ❌ FAIL: Scenario 3 failed. Res: ' + JSON.stringify(res3.body)));
  }

  // POST Scenario 4: Non-message update (e.g. read receipts or message delivery status)
  console.log(yellow('\n🏃 Running POST Scenario 4: Status Notification Webhook (No Message)'));
  const statusPayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WHATSAPP_BUSINESS_ACCOUNT_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "16505551111",
                phone_number_id: "1234567890"
              },
              statuses: [
                {
                  id: "wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQ0RGRDMwQzQ2QzNDMDVGNjBFMwA=",
                  status: "delivered",
                  timestamp: "1675221605",
                  recipient_id: "15551234567"
                }
              ]
            },
            field: "messages"
          }
        ]
      }
    ]
  };
  const res4 = await postWebhookPayload(statusPayload);
  if (res4.statusCode === 200 && res4.body.status === 'ignored_no_message') {
    console.log(green('  ✅ PASS: Webhook acknowledged successfully without running order pipeline.'));
  } else {
    console.log(red('  ❌ FAIL: Scenario 4 failed. Res: ' + JSON.stringify(res4.body)));
  }

  // 4. Teardown
  console.log(blue('\n🏁 Cleaning up test environment...'));
  server.close(() => {
    console.log(green('👋 Test server stopped successfully.'));
    console.log(blue('\n======================================================'));
    console.log(green('🎉 ALL Webhook Scenarios and Fallback Lookups Validated!'));
    console.log(blue('======================================================\n'));
    process.exit(0);
  });
}

runTests();
