/**
 * Restaurant Menu Reset Service
 *
 * A Cloudflare Cron Trigger job (daily, 03:00 UTC) that resets is_available to
 * true for every product of every 'restaurant' client. The OUT/IN merchant
 * commands (restaurantService) mark individual items unavailable during the
 * day; this job guarantees the menu is fully available again at the start of
 * each day so a forgotten OUT timeout never silently kills an item.
 *
 * Gate: RESTAURANT_MENU_RESET_ENABLED — 'false' (or unset) disables the job;
 * the flag is honored by src/worker.js when dispatching the Cron Trigger, same
 * pattern as REMINDERS_ENABLED / SUPPLIER_NUDGES_ENABLED / DAILY_SUMMARY_ENABLED.
 */

const db = require('../config/db');

/**
 * Run one pass of the menu-reset job (exported for direct invocation/tests).
 * @returns {Promise<{ checked: number, reset: Array<{ client_id: string, products_reset: number }> }>}
 */
async function runMenuResetJob() {
  const clients = await db.getRestaurantClients();
  console.log(`🍽️ Menu-reset job: checking ${clients.length} restaurant client(s)...`);

  const reset = [];
  for (const client of clients) {
    const productsReset = await db.resetProductsAvailable(client.id);
    if (productsReset > 0) {
      console.log(`✅ Reset ${productsReset} product(s) to available for client ${client.id} (${client.business_name})`);
    }
    reset.push({ client_id: client.id, products_reset: productsReset });
  }

  return { checked: clients.length, reset };
}

// Cloudflare Cron Trigger schedule for this job. The string must match
// wrangler.toml [triggers] crons exactly; src/worker.js dispatches the
// scheduled() handler on controller.cron.
const CRON_SCHEDULE = '0 3 * * *'; // daily at 03:00 UTC

module.exports = {
  runMenuResetJob,
  CRON_SCHEDULE
};