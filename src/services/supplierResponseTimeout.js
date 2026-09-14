/**
 * Supplier Response Timeout Service
 *
 * Automated nudging for dropshipper orders stuck in 'pending_supplier_confirmation'.
 * A Cloudflare Cron Trigger job (default hourly) looks for orders still awaiting
 * a supplier's YES/NO and drives two thresholds relative to order creation:
 *
 *   1x SUPPLIER_RESPONSE_TIMEOUT_HOURS (default 4) ago:
 *        nudge the supplier ONCE (order -> supplier_nudged_at set).
 *   2x SUPPLIER_RESPONSE_TIMEOUT_HOURS (default 8) ago:
 *        stop waiting on the supplier — notify the SELLER (the client's own
 *        business line) so they can intervene manually (order -> supplier_escalated_at).
 *
 * Dedup mirrors reminderService: each nudge/escalation is fired at most once per
 * order. A failed WhatsApp send does NOT advance the timestamp, so the next run
 * retries. Escalation is modeled as its own event (not a status change): the order
 * stays 'pending_supplier_confirmation' until the supplier replies or the seller
 * intervenes.
 *
 * Config:
 *   SUPPLIER_RESPONSE_TIMEOUT_HOURS - first-nudge threshold in hours (default 4)
 *
 * Note: the "disable" flag SUPPLIER_NUDGES_ENABLED is honored by src/worker.js
 * when dispatching the Cron Trigger (cloud cron schedules can't be toggled at
 * runtime), while the old SUPPLIER_NUDGE_CRON env schedule override is no longer
 * supported — the schedule now lives in wrangler.toml.
 */

const db = require('../config/db');
const whatsappService = require('./whatsappService');

const HOUR_MS = 60 * 60 * 1000;

function responseTimeoutHours() {
  const fromEnv = Number(process.env.SUPPLIER_RESPONSE_TIMEOUT_HOURS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 4;
}

/**
 * Build the nudge message sent to a supplier for an order still awaiting their
 * YES/NO past the first timeout threshold.
 * @param {Object} order - pending_supplier_confirmation order row
 * @returns {string}
 */
function buildSupplierNudgeMessage(order) {
  const shortId = String(order.id).slice(0, 8).toUpperCase();
  return (
    `⏰ Still waiting on order #${shortId} (${order.id}).\n\n` +
    `It was sent to you for confirmation a while ago and hasn't been answered yet.\n\n` +
    `Reply YES to confirm fulfillment or NO to decline.`
  );
}

/**
 * Build the escalation message sent to the SELLER (client's own line) when a
 * supplier has still not responded after 2x the timeout window.
 * @param {Object} order - pending_supplier_confirmation order row
 * @param {Object} supplier - the order's supplier row (for name)
 * @returns {string}
 */
function buildSellerEscalationMessage(order, supplier) {
  const shortId = String(order.id).slice(0, 8).toUpperCase();
  return (
    `🚨 Supplier hasn't responded to order #${shortId} (${order.id}).\n\n` +
    `Supplier: ${supplier ? supplier.name : 'Unknown'}\n` +
    `Total: ₦${Number(order.total_amount).toFixed(2)}\n\n` +
    `The supplier ignored the confirmation request for several hours. ` +
    `You may want to contact them directly or cancel/redirect this order.`
  );
}

/**
 * Run one pass of the supplier-timeout job (exported for direct invocation/tests).
 * @param {Date} [now] - For deterministic tests.
 * @returns {Promise<{ checked: number, nudged: Array<string>, escalated: Array<string> }>}
 */
async function runSupplierTimeoutJob(now = new Date()) {
  const orders = await db.getAwaitingSupplierOrders();
  console.log(`🚨 Supplier-timeout job: checking ${orders.length} order(s) in pending_supplier_confirmation...`);

  const nudged = [];
  const escalated = [];
  const timeoutHours = responseTimeoutHours();

  for (const order of orders) {
    const created = new Date(order.created_at);
    if (Number.isNaN(created.getTime())) continue;

    const ageHours = (now.getTime() - created.getTime()) / HOUR_MS;
    if (ageHours < timeoutHours) continue;

    const supplier = await db.getSupplierById(order.supplier_id, order.client_id);

    if (ageHours >= 2 * timeoutHours) {
      if (order.supplier_escalated_at) continue;
      const seller = order.client_id ? await db.getClientById(order.client_id) : null;
      const sellerPhone = seller ? seller.whatsapp_number : null;
      if (!sellerPhone) {
        console.warn(`⚠️ Escalation for order ${order.id}: seller has no whatsapp_number, skipping.`);
        continue;
      }
      const message = buildSellerEscalationMessage(order, supplier);
      const result = await whatsappService.sendTextMessage(sellerPhone, message);
      if (result && result.success === true) {
        await db.markSupplierEscalated(order.id, order.client_id);
        console.log(`🚨 Escalated order ${order.id} to seller ${sellerPhone} (${order.id})`);
        escalated.push(order.id);
      } else {
        console.error(`⚠️ Escalation NOT sent for order ${order.id}: ${JSON.stringify(result)}`);
      }
      continue;
    }

    if (order.supplier_nudged_at) continue;
    const supplierPhone = supplier ? supplier.contact_phone : null;
    if (!supplierPhone) {
      console.warn(`⚠️ Nudge for order ${order.id}: supplier has no contact_phone, skipping.`);
      continue;
    }
    const message = buildSupplierNudgeMessage(order);
    const result = await whatsappService.sendTextMessage(supplierPhone, message);
    if (result && result.success === true) {
      await db.markSupplierNudged(order.id, order.client_id);
      console.log(`⏰ Nudged supplier ${supplierPhone} about order ${order.id}`);
      nudged.push(order.id);
    } else {
      console.error(`⚠️ Nudge NOT sent for order ${order.id}: ${JSON.stringify(result)}`);
    }
  }

  return { checked: orders.length, nudged, escalated };
}

// Cloudflare Cron Trigger schedule for this job. The string must match
// wrangler.toml [triggers] crons exactly; src/worker.js dispatches the
// scheduled() handler on controller.cron.
const CRON_SCHEDULE = '0 * * * *'; // hourly

module.exports = {
  responseTimeoutHours,
  buildSupplierNudgeMessage,
  buildSellerEscalationMessage,
  runSupplierTimeoutJob,
  CRON_SCHEDULE
};