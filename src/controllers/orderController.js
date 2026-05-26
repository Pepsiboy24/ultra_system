/**
 * Order Controller
 * 
 * Exposes Express API routing for order processing.
 * Endpoint: POST /api/process-order
 */

const express = require('express');
const router = express.Router();
const aiService = require('../services/aiService');
const orderService = require('../services/orderService');
const db = require('../config/db');
const geminiClient = require('../config/gemini');

router.post('/process-order', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid "message" in request body.'
      });
    }

    console.log('\n--- 📥 Incoming B2B WhatsApp Message ---');
    console.log(`"${message}"`);
    console.log('----------------------------------------');

    // 1. NLP parsing via Gemini AI (or Heuristics fallback)
    let parsedOrder;
    try {
      parsedOrder = await aiService.parseOrderMessage(message);
    } catch (aiError) {
      console.error('❌ AI Extraction Error:', aiError.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to extract structured data from order message.',
        details: aiError.message
      });
    }

    console.log('🤖 AI Extracted JSON:', JSON.stringify(parsedOrder, null, 2));

    // 2. Validate & Process through order pipeline (database transactions)
    const pipelineResult = await orderService.processOrderPipeline(parsedOrder);

    // 3. Formulate response payload
    const responsePayload = {
      success: pipelineResult.success,
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

    // Return HTTP 200 with order confirmation details
    // If supplier wasn't found (rejection), it returns success: false with order details.
    return res.status(200).json(responsePayload);

  } catch (error) {
    console.error('❌ Pipeline Server Error:', error);
    return res.status(500).json({
      success: false,
      error: 'An internal server error occurred while processing the order.',
      details: error.message
    });
  }
});

module.exports = router;
