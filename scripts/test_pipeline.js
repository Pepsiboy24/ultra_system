/**
 * End-to-End Pipeline Verification Script
 * 
 * Boots up the Express server, runs HTTP tests simulating the four B2B scenarios,
 * and prints color-coded, detailed validations to verify proper pipeline execution.
 */

const http = require('http');
const app = require('../src/app');

const PORT = 3500;
let server;

// Start local Express server for testing
function startServer() {
  return new Promise((resolve) => {
    server = app.listen(PORT, () => {
      resolve();
    });
  });
}

// Make a POST request helper
function postMessage(message) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ message });
    
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: '/api/process-order',
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
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
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

async function runTests() {
  console.log(blue('\n======================================================'));
  console.log(blue('🍵 Starting B2B Order Pipeline End-to-End Test Suite'));
  console.log(blue('======================================================\n'));

  // 1. Boot Server
  await startServer();
  console.log(green(`📡 Live test server started on http://localhost:${PORT}`));

  // 2. Define scenarios
  const scenarios = [
    {
      name: 'Scenario A: Successful Order Processing',
      message: "Hey this is Golden Tea Co., we'd like to order 10 bags of Earl Grey and 5 bags of Chamomile.",
      verify: (res) => {
        const pass = res.success === true && res.pipeline_result.status === 'approved' && res.pipeline_result.total_amount === 212.50 && res.pipeline_result.payment_link !== null;
        if (pass) {
          console.log(green('  ✅ PASS: Order approved. Total amount $212.50. Payment link issued successfully.'));
        } else {
          console.log(red('  ❌ FAIL: Scenario A did not return expected outcome.'));
          console.log(JSON.stringify(res, null, 2));
        }
      }
    },
    {
      name: 'Scenario B: Inventory Rejection (Out of Stock)',
      message: "Hi, Matcha Supreme here, we need 30 bags of Ceremonial Matcha.",
      verify: (res) => {
        const pass = res.success === false && res.pipeline_result.status === 'rejected' && res.pipeline_result.reason.includes('Insufficient stock');
        if (pass) {
          console.log(green('  ✅ PASS: Order correctly rejected due to insufficient stock (Requested 30, only 20 available).'));
        } else {
          console.log(red('  ❌ FAIL: Scenario B did not trigger stock rejection.'));
          console.log(JSON.stringify(res, null, 2));
        }
      }
    },
    {
      name: 'Scenario C: Credit Limit Rejection',
      message: "Hi, this is Darjeeling Imports. We'd like to order 40 bags of Earl Grey.",
      verify: (res) => {
        // Darjeeling Price total: 40 * $15 = $600. Available credit is $2000 - $1500 = $500. $600 > $500, should reject
        const pass = res.success === false && res.pipeline_result.status === 'rejected' && res.pipeline_result.reason.includes('Credit limit exceeded');
        if (pass) {
          console.log(green('  ✅ PASS: Order correctly rejected. Requested total $600.00 exceeds supplier\'s available credit of $500.00.'));
        } else {
          console.log(red('  ❌ FAIL: Scenario C did not trigger credit limit rejection.'));
          console.log(JSON.stringify(res, null, 2));
        }
      }
    },
    {
      name: 'Scenario D: Unknown Supplier Rejection',
      message: "Hello, this is Bob's Coffee House. Can we order 10 Earl Grey?",
      verify: (res) => {
        const pass = res.success === false && res.pipeline_result.reason.includes('Supplier "Bob\'s Coffee House" not found');
        if (pass) {
          console.log(green('  ✅ PASS: Order correctly rejected. Supplier "Bob\'s Coffee House" was not found in active B2B database.'));
        } else {
          console.log(red('  ❌ FAIL: Scenario D did not trigger supplier verification error.'));
          console.log(JSON.stringify(res, null, 2));
        }
      }
    }
  ];

  // 3. Execute Scenarios sequentially
  for (const scenario of scenarios) {
    console.log(yellow(`\n🏃 Running: ${scenario.name}`));
    console.log(`💬 Message: "${scenario.message}"`);
    
    try {
      const res = await postMessage(scenario.message);
      
      console.log(`🤖 AI Extracted: Supplier="${res.nlp_extraction.supplier_name}", Items=${JSON.stringify(res.nlp_extraction.items)}`);
      console.log(`📊 Result: Status=${res.pipeline_result.status}, Reason="${res.pipeline_result.reason || 'None'}", Link=${res.pipeline_result.payment_link || 'None'}`);
      
      scenario.verify(res);
    } catch (err) {
      console.error(red(`  💥 ERROR running scenario: ${err.message}`));
    }
  }

  // 4. Teardown
  console.log(blue('\n🏁 Cleaning up test environment...'));
  server.close(() => {
    console.log(green('👋 Test server stopped successfully.'));
    console.log(blue('\n======================================================'));
    console.log(green('🎉 ALL B2B Pipeline Scenarios Validated successfully!'));
    console.log(blue('======================================================\n'));
    process.exit(0);
  });
}

runTests();
