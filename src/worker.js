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
const { default: menuResetService } = await import('./services/menuResetService.js');

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
    case menuResetService.CRON_SCHEDULE:
      if (process.env.RESTAURANT_MENU_RESET_ENABLED === 'false') {
        console.log('🍽️ Restaurant menu-reset job skipped (RESTAURANT_MENU_RESET_ENABLED=false).');
        return;
      }
      await menuResetService.runMenuResetJob(triggerTime);
      break;
    default:
      console.error(`❌ No job mapped for cron schedule "${controller.cron}".`);
  }
}

const serverHandler = httpServerHandler({ port: PORT });

/**
 * Verify Meta's X-Hub-Signature-256 on WhatsApp webhook POSTs (HMAC-SHA256 of
 * the exact request body, keyed with the app secret). Without this, anyone who
 * knows the URL could post fake messages (including a fake "READY" from the
 * kitchen number). Enforced whenever META_APP_SECRET is set.
 */
async function verifyMetaSignature(request) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    console.warn('⚠️ META_APP_SECRET is not set — WhatsApp webhook signatures are NOT being verified.');
    return true;
  }
  const header = request.headers.get('x-hub-signature-256') || '';
  if (!header.startsWith('sha256=')) return false;
  const provided = header.slice(7).toLowerCase();
  const body = await request.clone().arrayBuffer();
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, body);
  const expected = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== provided.length) return false;
  let diff = 0; // constant-time compare
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && pathname.replace(/\/+$/, '') === '/api/webhook') {
      if (!(await verifyMetaSignature(request))) {
        console.error('🚫 Rejected WhatsApp webhook POST: missing/invalid X-Hub-Signature-256.');
        return new Response('Invalid signature', { status: 401 });
      }
    }
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