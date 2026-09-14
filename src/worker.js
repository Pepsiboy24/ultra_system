/**
 * Cloudflare Workers entry point for the B2B Tea Order Pipeline.
 *
 * The Express app in src/app.js is used as-is (this is the Express-compat
 * mode, not a rewrite). WORKER_RUNTIME is set before app.js is imported so
 * its own app.listen() is skipped; this file binds it on the same PORT and
 * hands the Node-compatible HTTP server to httpServerHandler, which routes
 * incoming Worker requests into Express.
 *
 * The scheduled() handler maps the configured Cron Triggers (wrangler.toml
 * [triggers] crons) to their job functions by matching controller.cron with
 * each job's CRON_SCHEDULE constant. Each job's disable flag
 * (REMINDERS_ENABLED / SUPPLIER_NUDGES_ENABLED / DAILY_SUMMARY_ENABLED) is
 * honored here, since platform cron schedules can't be toggled at runtime.
 */
import { httpServerHandler } from 'cloudflare:node';

process.env.WORKER_RUNTIME = '1';

// Cloudflare's nodejs_compat emulation sets process.versions.node, which makes
// iconv-lite (used by Express body-parser -> raw-body) load its Node-only
// extensions (lib/streams, lib/extend-node). The workerd bundler marks those
// files disabled, so calling them throws. Blanking the version makes
// iconv-lite skip that branch entirely; nothing else in this app reads it.
process.versions.node = '';

// The workerd bundler does not provide __dirname/__filename to CommonJS
// modules. Some bundled CommonJS references them at module load just to
// compute paths, so provide inert globals before app/service modules load.
// Real filesystem access is never attempted from these paths under Workers.
if (typeof __filename === 'undefined') {
  globalThis.__filename = '/src/worker.js';
}
if (typeof __dirname === 'undefined') {
  globalThis.__dirname = '/src';
}

const { default: app } = await import('./app.js');
const { default: reminderService } = await import('./services/reminderService.js');
const { default: supplierResponseTimeout } = await import('./services/supplierResponseTimeout.js');
const { default: dailySummaryService } = await import('./services/dailySummaryService.js');

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT);

/**
 * Dispatch a Cron Trigger invocation to its job.
 * @param {import('cloudflare:workers').ScheduledController} controller
 */
async function runScheduled(controller) {
  const triggerTime = controller.scheduledTime ? new Date(controller.scheduledTime) : new Date();

  switch (controller.cron) {
    case reminderService.CRON_SCHEDULE:
      if (process.env.REMINDERS_ENABLED === 'false') {
        console.log('📅 Reminder job skipped (REMINDERS_ENABLED=false).');
        return;
      }
      await reminderService.runReminderJob(triggerTime);
      break;
    case supplierResponseTimeout.CRON_SCHEDULE:
      if (process.env.SUPPLIER_NUDGES_ENABLED === 'false') {
        console.log('🚨 Supplier-timeout job skipped (SUPPLIER_NUDGES_ENABLED=false).');
        return;
      }
      await supplierResponseTimeout.runSupplierTimeoutJob(triggerTime);
      break;
    case dailySummaryService.CRON_SCHEDULE:
      if (process.env.DAILY_SUMMARY_ENABLED === 'false') {
        console.log('📊 Daily-summary job skipped (DAILY_SUMMARY_ENABLED=false).');
        return;
      }
      await dailySummaryService.runDailySummaryJob(triggerTime);
      break;
    default:
      console.error(`❌ No job mapped for cron schedule "${controller.cron}".`);
  }
}

const serverHandler = httpServerHandler({ port: PORT });

export default {
  async fetch(request) {
    // httpServerHandler returns a fetch handler; adapt whether it is a bare
    // function or an object with a fetch method.
    if (typeof serverHandler === 'function') {
      return serverHandler(request);
    }
    return serverHandler.fetch(request);
  },
  async scheduled(controller, env, ctx) {
    try {
      await runScheduled(controller);
    } catch (error) {
      console.error(`❌ Scheduled job crashed (${controller.cron}):`, error);
    }
  }
};