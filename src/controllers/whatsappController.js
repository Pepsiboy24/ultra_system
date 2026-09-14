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
const whatsappService = require('../services/whatsappService');
const db = require('../config/db');
const cloudflareClient = require('../config/cloudflare');

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
      const status = value?.statuses?.[0];
      if (status) {
        console.log(`💡 Status Update: message ${status.id} -> "${status.status}" for ${status.recipient_id}`);
        if (status.status === 'failed' && status.errors) {
          console.error('❌ WhatsApp Delivery Failed:', JSON.stringify(status.errors, null, 2));
        }
      } else {
        console.log('💡 Info: Webhook event does not contain a message payload (e.g. standard status update/read receipt).');
        console.log('Raw payload:', JSON.stringify(req.body, null, 2));
      }
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

    // Resolve the tenant (client) from the business line BEFORE anything else so
    // every downstream branch (supplier reply, customer confirm, fresh order) is
    // scoped and can be disambiguated by it.
    const businessPhone = value?.metadata?.display_phone_number;
    const client = businessPhone ? await db.getClientByPhone(businessPhone) : null;
    const businessCategory = client ? client.business_category : undefined;
    console.log(`🏢 Business category: ${businessCategory || 'n/a (generic fallback)'} (business number: ${businessPhone || 'unspecified'}, resolved client: ${client?.business_name || 'none'})`);

    // DISAMBIGUATION RULE 0 (SELLER commands): before anything else, check the
    // "READY <short>" and "PROGRESS <short>" text commands from the client's
    // OWN business line (see processSellerReadyCommand /
    // processSellerProgressCommand). Only exact commands are consumed here; any
    // other text falls through. Each command has its own regex so at most one
    // of the two can match.
    const sellerReady = client ? await orderService.processSellerReadyCommand(from, client.id, textBody) : { handled: false };
    if (sellerReady.handled) {
      console.log(`📦 Seller READY [${sellerReady.action}] from ${from} for order ${sellerReady.order?.id || '?'}.`);
      return res.status(200).json({
        success: true,
        status: `seller_${sellerReady.action}`,
        order_id: sellerReady.order ? sellerReady.order.id : null,
        sender: from,
        system_metadata: {
          database_mode: db.isMock ? 'LOCAL_MOCK_JSON' : 'SUPABASE_POSTGRES',
          ai_engine_mode: cloudflareClient.isMock ? 'HEURISTIC_MOCK_NLP' : 'LIVE_CLOUDFLARE_LLAMA_3_1_8B',
          processed_at: new Date().toISOString()
        }
      });
    }

    const sellerProgress = client ? await orderService.processSellerProgressCommand(from, client.id, textBody) : { handled: false };
    if (sellerProgress.handled) {
      console.log(`📦 Seller PROGRESS [${sellerProgress.action}] from ${from} for order ${sellerProgress.order?.id || '?'}.`);
      return res.status(200).json({
        success: true,
        status: `seller_${sellerProgress.action}`,
        order_id: sellerProgress.order ? sellerProgress.order.id : null,
        sender: from,
        system_metadata: {
          database_mode: db.isMock ? 'LOCAL_MOCK_JSON' : 'SUPABASE_POSTGRES',
          ai_engine_mode: cloudflareClient.isMock ? 'HEURISTIC_MOCK_NLP' : 'LIVE_CLOUDFLARE_LLAMA_3_1_8B',
          processed_at: new Date().toISOString()
        }
      });
    }

    // DISAMBIGUATION RULE 1 (SUPPLIER): before the customer confirmation branch,
    // check whether this sender is a supplier of this tenant with an order in
    // 'pending_supplier_confirmation' awaiting their YES/NO. Anchored to the
    // awaiting order (see orderService.processSupplierReply) so it only fires for
    // an explicit supplier reply; anything else falls through to normal handling.
    const supplierReply = client ? await orderService.processSupplierReply(from, client.id, textBody) : { handled: false };
    if (supplierReply.handled) {
      console.log(`📦 Supplier reply [${supplierReply.action}] from ${from} for order ${supplierReply.order?.id || '?'}.`);
      return res.status(200).json({
        success: true,
        status: `supplier_${supplierReply.action}`,
        order_id: supplierReply.order ? supplierReply.order.id : null,
        sender: from,
        system_metadata: {
          database_mode: db.isMock ? 'LOCAL_MOCK_JSON' : 'SUPABASE_POSTGRES',
          ai_engine_mode: cloudflareClient.isMock ? 'HEURISTIC_MOCK_NLP' : 'LIVE_CLOUDFLARE_LLAMA_3_1_8B',
          processed_at: new Date().toISOString()
        }
      });
    }

    // DISAMBIGUATION RULE 1b (OPS CONTACT): between the supplier rule and the
    // customer-confirmation branch. Mirrors Rule 1's anchored pattern: the
    // message is only handled when `from` is this tenant's OWN
    // operations_contact_phone AND an order is still in
    // 'pending_ops_confirmation' awaiting their stock approval (oldest first,
    // see orderService.processOpsReply). An order can never be awaiting BOTH
    // the supplier and the ops contact, so rule 1 and rule 1b are mutually
    // exclusive per order; 1b is checked second so a reply from a dual-role
    // supplier+ops number is still resolved supplier-first.
    const opsReply = client ? await orderService.processOpsReply(from, client.id, textBody) : { handled: false };
    if (opsReply.handled) {
      console.log(`📦 Ops reply [${opsReply.action}] from ${from} for order ${opsReply.order?.id || '?'}.`);
      return res.status(200).json({
        success: true,
        status: `ops_${opsReply.action}`,
        order_id: opsReply.order ? opsReply.order.id : null,
        sender: from,
        system_metadata: {
          database_mode: db.isMock ? 'LOCAL_MOCK_JSON' : 'SUPABASE_POSTGRES',
          ai_engine_mode: cloudflareClient.isMock ? 'HEURISTIC_MOCK_NLP' : 'LIVE_CLOUDFLARE_LLAMA_3_1_8B',
          processed_at: new Date().toISOString()
        }
      });
    }

    // DISAMBIGUATION RULE 2 (CUSTOMER confirm/cancel): if we're waiting on
    // confirmation for a previously held order, the incoming text is Y/N
    // feedback from the customer, not a new order.
    const conversation = await db.getConversationState(from);

    // If the pending order has been sitting in awaiting_confirmation longer
    // than the timeout window, it's stale — clear it and parse this message as
    // a fresh order instead of re-asking about a 30-minute-old order forever.
    if (conversation.state === 'awaiting_confirmation' && orderService.isConfirmationExpired(conversation.updated_at)) {
      console.log(`⏰ Pipeline: Pending order for ${from} expired after ${orderService.CONFIRMATION_TIMEOUT_MINUTES} min without reply — clearing state and treating this message as a new order.`);
      await db.clearConversationState(from);
      conversation.state = 'idle';
      conversation.pending_order_data = null;
    }

    const replyBody = textBody.trim().toLowerCase();

    const YES_WORDS = ['yes', 'y', 'confirm', 'confirmed'];
    const NO_WORDS = ['no', 'n', 'cancel'];

    if (conversation.state === 'awaiting_confirmation') {
      let replyText;

      if (YES_WORDS.includes(replyBody)) {
        const confirmResult = await orderService.confirmPendingOrder(from);
        console.log(`✅ Pipeline: Pending order confirmed. ${confirmResult.success ? `Order ${confirmResult.order?.id}` : confirmResult.reason}`);
        replyText = whatsappService.buildOrderReplyMessage(confirmResult);
      } else if (NO_WORDS.includes(replyBody)) {
        const cancelResult = await orderService.cancelPendingOrder(from);
        console.log(`🗑️ Pipeline: Pending order cancelled. ${cancelResult.had_pending ? '(had pending order)' : '(nothing pending)'}`);
        replyText = 'Order cancelled. Send a new order anytime.';
      } else {
        console.log(`💬 Info: Ambiguous reply "${textBody}" while awaiting confirmation — re-asking.`);
        replyText = 'Please reply YES to confirm or NO to cancel your pending order.';
      }

      await whatsappService.sendTextMessage(from, replyText);

      return res.status(200).json({
        success: true,
        status: 'confirmation_reply',
        sender: from,
        reply: replyText,
        state_before: conversation.state,
        system_metadata: {
          database_mode: db.isMock ? 'LOCAL_MOCK_JSON' : 'SUPABASE_POSTGRES',
          ai_engine_mode: cloudflareClient.isMock ? 'HEURISTIC_MOCK_NLP' : 'LIVE_CLOUDFLARE_LLAMA_3_1_8B',
          processed_at: new Date().toISOString()
        }
      });
    }

    // --- Idle: a normal new order message ---
    // (client/tenancy resolution happened up front; businessCategory is already known)

    // 1. NLP parsing via AI (or Heuristics fallback)
    console.log('🤖 Dispatched to NLP AI Parser...');
    let parsedOrder;
    try {
      parsedOrder = await aiService.parseOrderMessage(textBody, businessCategory);
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
    const pipelineResult = await orderService.processOrderPipeline(parsedOrder, from, businessCategory, businessPhone);

    console.log('📦 Pipeline Final Status:', pipelineResult.pending ? 'PENDING CONFIRMATION ⏳' : (pipelineResult.success ? 'APPROVED ✅' : 'REJECTED ❌'));
    if (pipelineResult.reason) {
      console.log(`⚠️ Failure Reason: "${pipelineResult.reason}"`);
    }

    // 3. Send a WhatsApp reply back to the customer with the order outcome.
    //    Held orders get the confirmation prompt; finished ones get the normal reply.
    const replyText = pipelineResult.pending
      ? pipelineResult.confirmation_message
      : whatsappService.buildOrderReplyMessage(pipelineResult);
    await whatsappService.sendTextMessage(from, replyText);

    const responsePayload = {
      success: pipelineResult.success,
      status: pipelineResult.pending ? 'pending_confirmation' : (pipelineResult.success ? 'processed' : 'rejected'),
      sender: from,
      reply: replyText,
      nlp_extraction: parsedOrder,
      pipeline_result: {
        status: pipelineResult.pending ? 'awaiting_confirmation' : (pipelineResult.order ? pipelineResult.order.status : 'failed'),
        reason: pipelineResult.reason || pipelineResult.order?.status_reason || null,
        order_id: pipelineResult.order ? pipelineResult.order.id : null,
        total_amount: pipelineResult.pending ? pipelineResult.pending_order.total_amount : (pipelineResult.order ? pipelineResult.order.total_amount : 0.00),
        payment_link: pipelineResult.order ? pipelineResult.order.payment_link : null,
        items: pipelineResult.items || []
      },
      system_metadata: {
        database_mode: db.isMock ? 'LOCAL_MOCK_JSON' : 'SUPABASE_POSTGRES',
        ai_engine_mode: cloudflareClient.isMock ? 'HEURISTIC_MOCK_NLP' : 'LIVE_CLOUDFLARE_LLAMA_3_1_8B',
        business_category: businessCategory || null,
        resolved_client: client ? client.business_name : null,
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