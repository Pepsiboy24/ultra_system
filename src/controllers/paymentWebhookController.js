/**
 * Monnify Payment Webhook Controller
 *
 * Receives Monnify's payment-confirmed events at POST /api/payments/webhook.
 * Security model (per Monnify docs):
 *   - Every notification carries a `monnify-signature` header = HMAC-SHA512 of
 *     the RAW request body keyed with the merchant client secret.
 *   - This route MUST be mounted with express.raw() (NOT express.json()) so the
 *     exact body bytes can be hashed; express.json() would re-write the body.
 *   - Signature is verified before ANY side effect (order update / WhatsApp).
 *   - Monnify resends undelivered notifications (retries ~10x) => idempotent.
 *
 * Flow: verify signature -> find order by stored transaction reference ->
 * amount guard -> set payment_status='paid' -> WhatsApp confirmation to the
 * customer -> ack with 200 so Monnify stops retrying.
 */

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const monnify = require('../config/monnify');
const whatsappService = require('../services/whatsappService');

const PAYMENT_CONFIRMED_EVENT = 'SUCCESSFUL_TRANSACTION';

function parseRawBody(raw) {
  try {
    return JSON.parse((Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '')) || '{}');
  } catch (err) {
    return null;
  }
}

router.post('/webhook', async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    const signature = req.get('monnify-signature');

    const { valid, reason } = monnify.verifyWebhookSignature(rawBody, signature);
    if (!valid) {
      console.warn(`❌ Monnify webhook REJECTED (${reason || 'invalid signature'}) — not acting on unverified notification.`);
      return res.sendStatus(401);
    }

    const body = parseRawBody(req.body);
    if (!body) {
      return res.status(400).json({ success: false, error: 'invalid_json_body' });
    }

    const eventData = body.eventData || {};

    if (body.eventType !== PAYMENT_CONFIRMED_EVENT || eventData.paymentStatus !== 'PAID') {
      console.log(`💡 Monnify webhook (${body.eventType || 'unknown'}): ignored.`);
      return res.status(200).json({ success: true, status: 'ignored' });
    }

    const txRef = eventData.transactionReference;
    if (!txRef) {
      return res.status(400).json({ success: false, error: 'missing_transaction_reference' });
    }

    const order = await db.getOrderByTransactionReference(txRef);
    if (!order) {
      console.warn(`⚠️ Monnify webhook: no order found for transactionReference "${txRef}".`);
      return res.status(200).json({ success: true, status: 'ignored_no_order' });
    }

    if (order.payment_status === 'paid') {
      console.log(`♻️ Monnify webhook: order ${order.id} already PAID — duplicate notification, acked.`);
      return res.status(200).json({ success: true, status: 'already_paid' });
    }

    // Amount guard (Monnify best practice): a "successful" event with an
    // amount below what we invoiced is treated as a partial/fraudulent payment
    // and must not mark the order paid.
    const expected = parseFloat(order.total_amount);
    const paid = typeof eventData.amountPaid === 'string'
      ? parseFloat(eventData.amountPaid)
      : Number(eventData.amountPaid);
    if (typeof paid !== 'number' || isNaN(paid) || paid < expected) {
      console.warn(`⚠️ Monnify webhook: amount mismatch on ${order.id} — expected ${expected}, got ${paid}. Not marking paid.`);
      return res.status(200).json({ success: true, status: 'amount_mismatch' });
    }

    await db.updateOrderPaymentStatus(order.id, 'paid', order.client_id);
    console.log(`✅ Payments: order ${order.id} marked PAID (tx ${txRef}).`);

    if (order.customer_phone) {
      const confirmation = whatsappService.buildPaymentConfirmationMessage({
        orderId: order.id,
        total_amount: order.total_amount,
        paymentMethod: eventData.paymentMethod
      });
      await whatsappService.sendTextMessage(order.customer_phone, confirmation);
    }

    return res.status(200).json({ success: true, status: 'paid', order_id: order.id });
  } catch (error) {
    console.error('❌ Monnify webhook exception:', error);
    return res.status(500).json({ success: false, error: 'webhook_processing_failed' });
  }
});

module.exports = router;