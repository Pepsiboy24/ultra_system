/**
 * Reminder Service
 *
 * Automated payment reminders for b2b orders with credit terms. A daily
 * Cloudflare Cron Trigger job looks for unpaid orders (payment_status='pending')
 * that have a credit term, derives a per-order reminder schedule from that
 * term, and sends the customer a WhatsApp reminder when a milestone becomes
 * due.
 *
 * Dedup: each order stores a `last_reminder_sent_at` timestamp. A milestone
 * is eligible only when its due date is strictly after that timestamp's date
 * (and not in the future). After a successful send the timestamp is set to
 * now, so re-running the job within the same day — or on any later day —
 * never re-sends an already-delivered milestone. At most one reminder is sent
 * per order per run; if a day was missed, the earliest skipped milestone is
 * caught up on the next run.
 *
 * The schedule is NOT hardcoded to net-7/net-10/net-14: milestones are
 * derived from the parsed term using REMINDER_FRACTIONS (default 0.5,0.7,1.0
 * of the term, rounded up, deduped — so a 14-day term yields days 7, 10, 14,
 * while a 30-day term yields 15, 21, 30).
 */

const db = require('../config/db');
const whatsappService = require('./whatsappService');

// Fraction-of-term milestones. Configurable via env REMINDER_FRACTIONS (e.g.
// "0.5,0.7,1.0"). Always includes the full term (1.0) as the final milestone.
function reminderFractions() {
  const fromEnv = (process.env.REMINDER_FRACTIONS || '0.5,0.7,1.0')
    .split(',')
    .map(s => parseFloat(s.trim()))
    .filter(f => Number.isFinite(f) && f > 0 && f <= 1);
  const fractions = fromEnv.length ? fromEnv : [0.5, 0.7, 1.0];
  if (!fractions.includes(1)) fractions.push(1);
  return fractions;
}

/**
 * Parse a credit term string into a number of days.
 * Handles: "14 days", "14-day credit", "net-30", "net 30", "30 d",
 * "2 weeks", "1 month". Returns null when no term can be derived.
 * @param {string|null} paymentTerms
 * @returns {number|null}
 */
function parsePaymentTermDays(paymentTerms) {
  if (!paymentTerms || typeof paymentTerms !== 'string') return null;
  const lower = paymentTerms.toLowerCase();
  const weekMatch = lower.match(/(\d+)\s*weeks?/);
  if (weekMatch) return parseInt(weekMatch[1], 10) * 7;
  const monthMatch = lower.match(/(\d+)\s*months?/);
  if (monthMatch) return parseInt(monthMatch[1], 10) * 30;
  const netMatch = lower.match(/net\s*-?\s*(\d+)/);
  if (netMatch) return parseInt(netMatch[1], 10);
  const dayMatch = lower.match(/(\d+)\s*(?:-?\s*day\s*credit|d\b|days?)/);
  if (dayMatch) return parseInt(dayMatch[1], 10);
  return null;
}

/**
 * Derive the reminder milestone days (offset from order creation) for a term.
 * @param {number} termDays
 * @returns {number[]} Unique, ascending integer days >= 1, ending at termDays.
 */
function milestoneDays(termDays) {
  if (!Number.isInteger(termDays) || termDays <= 0) return [];
  const days = reminderFractions().map(f => Math.max(1, Math.ceil(termDays * f)));
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Strip time so comparisons are calendar-day based. */
function dateOnly(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Pick the single reminder to send for an order right now, if any.
 * @param {Object} order - Order row (created_at, payment_terms, last_reminder_sent_at)
 * @param {Date} [today] - For deterministic tests.
 * @returns {{ milestoneDay: number, dueDate: Date } | null}
 */
function nextReminderDue(order, today = new Date()) {
  const termDays = parsePaymentTermDays(order.payment_terms);
  const created = new Date(order.created_at);
  if (!termDays || Number.isNaN(created.getTime())) return null;

  const milestones = milestoneDays(termDays);
  const lastSent = order.last_reminder_sent_at ? dateOnly(new Date(order.last_reminder_sent_at)) : new Date(0);
  const todayOnly = dateOnly(today.getTime());

  const due = [];
  for (const day of milestones) {
    const dueDate = dateOnly(created.getTime() + day * 24 * 60 * 60 * 1000);
    if (dueDate.getTime() > lastSent.getTime() && dueDate.getTime() <= todayOnly.getTime()) {
      due.push({ milestoneDay: day, dueDate });
    }
  }

  // Earliest unsent milestone wins; at most one reminder per run per order.
  return due.sort((a, b) => a.dueDate - b.dueDate)[0] || null;
}

/**
 * Format the reminder message for a customer.
 * @param {Object} order - Order row
 * @param {number} milestoneDay - Which schedule day triggered this reminder
 * @returns {string}
 */
function buildReminderMessage(order, milestoneDay) {
  const termDays = parsePaymentTermDays(order.payment_terms);
  const created = new Date(order.created_at);
  const todayOnly = dateOnly(Date.now());
  const dueDate = dateOnly(created.getTime() + termDays * 24 * 60 * 60 * 1000);
  const daysLeft = Math.round((dueDate.getTime() - todayOnly.getTime()) / (24 * 60 * 60 * 1000));

  let timing;
  if (daysLeft > 0) timing = `due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  else if (daysLeft === 0) timing = 'due today';
  else timing = `overdue by ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'}`;

  const business = order.business_name || '';
  return (
    `📅 Payment reminder — ${business}\n\n` +
    `This is a friendly reminder that your order is ${timing}.\n\n` +
    `Order #${order.id}\n` +
    `Total: ₦${Number(order.total_amount).toFixed(2)}\n` +
    (order.payment_link ? `Pay here: ${order.payment_link}\n` : '') +
    `Reminder schedule: net-${milestoneDay} check-in${termDays === milestoneDay ? ' (final due date)' : ''}.`
  );
}

/**
 * Run one pass of the reminder job (exported for direct invocation/tests).
 * @param {Date} [now] - For deterministic tests.
 * @returns {Promise<{ checked: number, sent: Array<{ order_id: string, success: boolean }> }>}
 */
async function runReminderJob(now = new Date()) {
  const orders = await db.getPendingOrdersWithTerms();
  console.log(`📅 Reminder job: checking ${orders.length} unpaid order(s) with credit terms...`);

  const sent = [];
  for (const order of orders) {
    const due = nextReminderDue(order, now);
    if (!due) continue;

    const message = buildReminderMessage(order, due.milestoneDay);
    const result = await whatsappService.sendTextMessage(order.customer_phone, message);

    // Only advance the dedup timestamp on a confirmed send, so a transient
    // failure lets the next daily run retry the same milestone.
    if (result && result.success === true) {
      await db.markOrderReminded(order.id, order.client_id);
      console.log(`✅ Reminder sent for order ${order.id} (net-${due.milestoneDay}) to ${order.customer_phone}`);
      sent.push({ order_id: order.id, success: true });
    } else {
      console.error(`⚠️ Reminder NOT sent for order ${order.id} (net-${due.milestoneDay}): ${JSON.stringify(result)}`);
      sent.push({ order_id: order.id, success: false });
    }
  }

  return { checked: orders.length, sent };
}

// Cloudflare Cron Trigger schedule for this job. The string must match
// wrangler.toml [triggers] crons exactly; src/worker.js dispatches the
// scheduled() handler on controller.cron.
const CRON_SCHEDULE = '0 9 * * *'; // daily at 09:00 UTC

module.exports = {
  parsePaymentTermDays,
  milestoneDays,
  reminderFractions,
  nextReminderDue,
  buildReminderMessage,
  runReminderJob,
  CRON_SCHEDULE
};