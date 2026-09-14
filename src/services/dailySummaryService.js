/**
 * Daily Summary Service
 *
 * A Cloudflare Cron Trigger job (every minute) delivers each client's end-of-
 * day order summary as a WhatsApp message to the business owner
 * (client.whatsapp_number). The delivery time is PER CLIENT via
 * clients.daily_summary_time (HH:MM UTC, default '09:00'). The Workers isolate
 * clock is UTC, so a WAT client (UTC+1, no DST) enters intended wall-clock time
 * minus 1h — e.g. '08:00' for a 9am WAT send (see scripts/onboardClient.js).
 *
 * On a matching tick the job:
 *   1. reads the day's orders for that client (active statuses, i.e. neither
 *      rejected nor cancelled, created within the local-midnight day window),
 *   2. aggregates total orders, booked revenue (sum of total_amount), unpaid order
 *      count (payment_status = 'pending') and best-selling item by units sold,
 *   3. sends the summary, then stamps clients.last_summary_sent_at = today so the
 *      report is dispatched at most once per day.
 *
 * A failed WhatsApp send does NOT stamp last_summary_sent_at, so the next matching
 * tick retries. Missed windows are skipped (no catch-up for previous days).
 *
 * Config:
 *   DAILY_SUMMARY_ENABLED - 'false' disables the job (tests/dev); honored by
 *                           src/worker.js when dispatching the Cron Trigger
 *
 * Note: the old DAILY_SUMMARY_CRON env schedule override is no longer supported
 * — the schedule now lives in wrangler.toml.
 */

const db = require('../config/db');
const whatsappService = require('./whatsappService');

const DAY_MS = 24 * 60 * 60 * 1000;

function formatNaira(amount) {
  return `₦${Number(amount).toFixed(2)}`;
}

/**
 * Build the daily summary WhatsApp message.
 * @param {Object} params
 * @param {string} params.businessName - client's business name
 * @param {string} params.dateLabel - human-readable day label (e.g. "Wed Sep 09 2026")
 * @param {Object} params.summary - result of db.getDailySummary
 * @returns {string}
 */
function buildDailySummaryMessage({ businessName, dateLabel, summary }) {
  const bestSeller = summary.bestSeller
    ? `${summary.bestSeller.name} (${summary.bestSeller.quantity})`
    : '—';
  return (
    `📊 Daily summary — ${businessName}\n` +
    `${dateLabel}\n\n` +
    `📦 Orders: ${summary.totalOrders}\n` +
    `💰 Revenue: ${formatNaira(summary.revenue)}\n` +
    `🏆 Best seller: ${bestSeller}\n` +
    `⏳ Unpaid orders: ${summary.unpaidOrders}`
  );
}

function dayWindow(now) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { dayStart: start, dayEnd: new Date(start.getTime() + DAY_MS) };
}

/**
 * Run one pass of the daily-summary job (exported for direct invocation/tests).
 * @param {Date} [now] - For deterministic tests.
 * @returns {Promise<{ checked: number, sent: Array<string>, skipped: Array<string> }>}
 */
async function runDailySummaryJob(now = new Date()) {
  const due = await db.getDueSummaryClients(now);
  console.log(`📊 Daily-summary job: ${due.length} client(s) due at ${now.toTimeString().slice(0, 5)}...`);

  const sent = [];
  const skipped = [];

  for (const client of due) {
    const { dayStart, dayEnd } = dayWindow(now);
    const summary = await db.getDailySummary(client.id, dayStart, dayEnd);
    const message = buildDailySummaryMessage({
      businessName: client.business_name,
      dateLabel: now.toDateString(),
      summary
    });
    const result = await whatsappService.sendTextMessage(client.whatsapp_number, message);
    if (result && result.success === true) {
      await db.markSummarySent(client.id);
      console.log(`📊 Sent daily summary to ${client.business_name} (${client.whatsapp_number})`);
      sent.push(client.id);
    } else {
      console.error(`⚠️ Summary NOT sent to ${client.business_name}: ${JSON.stringify(result)}`);
      skipped.push(client.id);
    }
  }

  return { checked: due.length, sent, skipped };
}

// Cloudflare Cron Trigger schedule for this job. The string must match
// wrangler.toml [triggers] crons exactly; src/worker.js dispatches the
// scheduled() handler on controller.cron.
const CRON_SCHEDULE = '* * * * *'; // every minute (per-client daily_summary_time gating)

module.exports = {
  buildDailySummaryMessage,
  runDailySummaryJob,
  CRON_SCHEDULE
};