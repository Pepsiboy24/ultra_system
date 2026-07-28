/**
 * WhatsApp Webhook Controller
 * 
 * Handles the Official WhatsApp Business Cloud API webhook endpoints.
 * - GET /api/webhook: Webhook verification handshake with Meta.
 * - POST /api/webhook: Real-time B2B incoming message capture and order pipeline trigger.
 */

const express = require('express');
const router = express.Router();
const aiService = require('../services/aiService');
const orderService = require('../services/orderService');
const db = require('../config/db');
const geminiClient = require('../config/gemini');

/**
 * GET /api/webhook
 * Handshake Verification for Meta Developer Portal
 */
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('\n--- 📡 Incoming Meta Webhook Handshake Verification ---');
  console.log(`hub.mode: ${mode}`);
  console.log(`hub.verify_token: ${token}`);
  console.log(`hub.challenge: ${challenge}`);

  const localVerifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'your-whatsapp-verify-token';

  if (mode === 'subscribe' && token === localVerifyToken) {
    console.log('✅ WhatsApp Webhook Verified Successfully.');
    console.log('------------------------------------------------------\n');
    return res.status(200).send(challenge);
  } else {
    console.warn('❌ WhatsApp Webhook Verification Failed: Verify Token Mismatch.');
    console.log('------------------------------------------------------\n');
    return res.sendStatus(403);
  }
});

/**
 * POST /api/webhook
 * Ingest Real-Time Webhook Messages from Meta
 */
router.post('/', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    // Log the arrival of a webhook notification
    const now = new Date().toLocaleTimeString();
    console.log(`\n[${now}] 📥 Webhook Received:`);

    if (!message) {
      console.log('💡 Info: Webhook event does not contain a message payload (e.g. standard status update/read receipt).');
      return res.status(200).json({ success: true, status: 'ignored_no_message' });
    }

    const from = message.from;
    const textBody = message.text?.body;

    console.log('==================================================');
    console.log(`📱 WHATSAPP MESSAGE RECEIVED FROM: ${from}`);
    console.log(`💬 MESSAGE CONTENT: "${textBody || '[Non-text message]'}"`);
    console.log('==================================================');

    if (!textBody || typeof textBody !== 'string' || textBody.trim() === '') {
      console.log('💡 Info: Text content is empty or invalid. Skipping pipeline execution.');
      return res.status(200).json({ success: true, status: 'ignored_empty_text' });
    }

    // 1. NLP parsing via Gemini AI (or Heuristics fallback)
    console.log('🤖 Dispatched to NLP AI Parser...');
    let parsedOrder;
    try {
      parsedOrder = await aiService.parseOrderMessage(textBody);
    } catch (aiError) {
      console.error('❌ AI Extraction Error:', aiError.message);
      return res.status(200).json({
        success: false,
        status: 'ai_error',
        error: 'Failed to extract structured data from order message.',
        details: aiError.message
      });
    }

    console.log('🤖 AI Extracted JSON Results:', JSON.stringify(parsedOrder, null, 2));

    // 2. Validate & Process through order pipeline (using sender phone number fallback)
    console.log('⚙️ Executing B2B Pipeline Validation & Database Transactions...');
    const pipelineResult = await orderService.processOrderPipeline(parsedOrder, from);

    console.log('📦 Pipeline Final Status:', pipelineResult.success ? 'APPROVED ✅' : 'REJECTED ❌');
    if (pipelineResult.reason) {
      console.log(`⚠️ Failure Reason: "${pipelineResult.reason}"`);
    }

    const responsePayload = {
      success: pipelineResult.success,
      status: pipelineResult.success ? 'processed' : 'rejected',
      sender: from,
      nlp_extraction: parsedOrder,
      pipeline_result: {
        status: pipelineResult.order ? pipelineResult.order.status : 'failed',
        reason: pipelineResult.reason || pipelineResult.order?.status_reason || null,
        order_id: pipelineResult.order ? pipelineResult.order.id : null,
        total_amount: pipelineResult.order ? pipelineResult.order.total_amount : 0.00,
        payment_link: pipelineResult.order ? pipelineResult.order.payment_link : null,
        items: pipelineResult.items || []
      },
      system_metadata: {
        database_mode: db.isMock ? 'LOCAL_MOCK_JSON' : 'SUPABASE_POSTGRES',
        ai_engine_mode: geminiClient.isMock ? 'HEURISTIC_MOCK_NLP' : 'LIVE_GEMINI_1_5_FLASH',
        processed_at: new Date().toISOString()
      }
    };

    // Return HTTP 200 with receipt status and process details
    return res.status(200).json(responsePayload);

  } catch (error) {
    console.error('❌ Webhook Processing Exception:', error);
    return res.status(500).json({
      success: false,
      error: 'An internal server error occurred while processing the webhook.',
      details: error.message
    });
  }
});

module.exports = router;
