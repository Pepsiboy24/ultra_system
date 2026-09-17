/**
 * B2B Tea Order Pipeline API Server
 * Express Server Entry Point
 */

require('dotenv').config();
const express = require('express');
const orderRoutes = require('./controllers/orderController');
const whatsappRoutes = require('./controllers/whatsappController');
const invoiceRoutes = require('./controllers/invoiceController');
const paymentWebhookRoutes = require('./controllers/paymentWebhookController');
const landingRoutes = require('./controllers/landingController');
const leadRoutes = require('./controllers/leadController');
const db = require('./config/db');
const cloudflareClient = require('./config/cloudflare');

const app = express();
const PORT = process.env.PORT || 3000;

// Body Parser Middleware.
// The Monnify webhook is mounted with express.raw() BEFORE express.json() so its
// signature (HMAC-SHA512 of the exact body bytes) can be verified. express.json()
// skips the request afterwards because the body is already consumed.
app.use('/api/payments/webhook', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Custom Request Logger for Premium Visual Feedback
app.use((req, res, next) => {
  const now = new Date().toLocaleTimeString();
  console.log(`[${now}] 🚀 HTTP ${req.method} ${req.url}`);
  next();
});

// Landing page (marketing site) — served before express.static() so the
// root '/' and '/privacy-policy' routes return the Worker-safe HTML even if
// the old public/ dashboard happens to exist on disk.
app.use('/', landingRoutes);

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Mounting the B2B Pipeline Route
app.use('/api', orderRoutes);
app.use('/api/webhook', whatsappRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/payments', paymentWebhookRoutes);
app.use('/api/leads', leadRoutes);

// Dashboard API Routes
app.get('/api/dashboard/orders', async (req, res) => {
  try {
    // Optional tenant scope: ?clientId=... (null = all tenants, dev dashboard).
    const orders = await db.getAllOrders(req.query.clientId || null);
    res.status(200).json(orders);
  } catch (error) {
    console.error('Error fetching dashboard orders:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch orders.' });
  }
});

app.get('/api/dashboard/suppliers', async (req, res) => {
  try {
    const suppliers = await db.getAllSuppliers(req.query.clientId || null);
    res.status(200).json(suppliers);
  } catch (error) {
    console.error('Error fetching dashboard suppliers:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch suppliers.' });
  }
});

app.put('/api/dashboard/suppliers/:id/credit-toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const { can_request_credit } = req.body;

    if (can_request_credit === undefined) {
      return res.status(400).json({ success: false, error: 'Missing "can_request_credit" boolean in request body.' });
    }

    const updatedSupplier = await db.toggleSupplierCredit(id, can_request_credit, req.query.clientId || null);
    if (!updatedSupplier) {
      return res.status(404).json({ success: false, error: `Supplier with ID ${id} not found.` });
    }

    console.log(`📡 DB: Toggled supplier credit for ${updatedSupplier.name} to ${updatedSupplier.can_request_credit}`);
    res.status(200).json({ success: true, supplier: updatedSupplier });
  } catch (error) {
    console.error('Error toggling supplier credit status:', error);
    res.status(500).json({ success: false, error: 'Failed to update supplier credit status.' });
  }
});

// Diagnostics Status Route (was the old JSON response at '/', now moved to
// /api/status so the root serves the Relay landing page).
app.get('/api/status', (req, res) => {
  res.status(200).json({
    name: 'B2B Tea Business Order Pipeline API',
    description: 'Processes incoming supplier WhatsApp order messages, validates inventory, verifies credit limits, and issues secure payment links.',
    status: 'ACTIVE',
    endpoints: {
      process_order: {
        path: '/api/process-order',
        method: 'POST',
        body_format: {
          message: 'Natural language string simulating WhatsApp text'
        }
      }
    },
    system_configuration: {
      port: PORT,
      database_mode: db.isMock ? 'LOCAL_MOCK_JSON' : 'SUPABASE_POSTGRES',
      ai_engine_mode: cloudflareClient.isMock ? 'HEURISTIC_MOCK_NLP' : 'LIVE_CLOUDFLARE_LLAMA_3_1_8B'
    },
    quick_start: 'Try sending a POST request to /api/process-order with the text of your tea request!'
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found.'
  });
});

// Start listening.
// Under Cloudflare Workers (src/worker.js) the app is bound by
// httpServerHandler({ port }) instead, which routes incoming requests to the
// Express server that listens on the same port internally. Setting
// WORKER_RUNTIME=1 is handled by the worker entry before this module loads.
if (process.env.WORKER_RUNTIME !== '1') {
  app.listen(PORT, () => {
    console.log('==================================================');
    console.log(`🍵 B2B Tea Order Server Running on http://localhost:${PORT}`);
    console.log(`📡 Database Mode: ${db.isMock ? 'LOCAL_MOCK_JSON (Simulated)' : 'SUPABASE_POSTGRES (Live)'}`);
    console.log(`🧠 AI Engine Mode: ${cloudflareClient.isMock ? 'MOCK_HEURISTIC_NLP (Simulated)' : 'LIVE_CLOUDFLARE_LLAMA_3_1_8B (Live)'}`);
    console.log('==================================================');
  });
}

module.exports = app;
