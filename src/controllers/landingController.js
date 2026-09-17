/**
 * Landing Controller
 *
 * Relay marketing site, served as self-contained HTML from the Worker at
 * GET / (mounted at '/'), plus GET /privacy-policy linked from the footer.
 *
 * Rendered in-memory and sent with res.type('html').send(...) — the same
 * approach as invoiceController — so it works on Cloudflare Workers, where
 * express.static() cannot read files from disk.
 *
 * The signup form POSTs to /api/leads (leadController). No WhatsApp account
 * is connected here and no Embedded Signup is implemented — leads are for
 * manual follow-up only.
 */

const express = require('express');
const router = express.Router();

const LOGO_SVG = `
<svg class="logo-mark" width="34" height="34" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
  <path d="M4 8a4 4 0 0 1 4-4h20a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4H16l-6 6v-6H8a4 4 0 0 1-4-4z" fill="#ffffff"/>
  <text x="18" y="24" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="800" fill="#10794E">R</text>
</svg>`;

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Relay — Take WhatsApp orders automatically</title>
<meta name="description" content="Relay turns customer WhatsApp messages into confirmed, invoiced orders for Nigerian wholesalers, restaurants and dropshippers.">
<style>
  :root {
    --dark: #0B3D2E;
    --teal: #10794E;
    --teal-bright: #16a06a;
    --ink: #0f172a;
    --muted: #d7e7e0;
    --card: #ffffff;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: var(--ink);
    background: #ffffff;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { width: 100%; max-width: 1080px; margin: 0 auto; padding: 0 20px; }
  section { padding: 56px 0; }
  h1, h2, h3 { line-height: 1.2; margin: 0 0 12px; }
  h2 { font-size: 26px; }
  p { margin: 0 0 14px; }

  /* Nav */
  .nav {
    position: sticky; top: 0; z-index: 10;
    background: rgba(11, 61, 46, 0.96);
    backdrop-filter: blur(6px);
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .nav .wrap { display: flex; align-items: center; justify-content: space-between; height: 62px; }
  .brand { display: flex; align-items: center; gap: 10px; color: #fff; font-weight: 800; font-size: 20px; letter-spacing: .2px; }
  .nav-cta {
    color: #fff; text-decoration: none; font-weight: 700; font-size: 14px;
    border: 1px solid rgba(255,255,255,0.35); padding: 8px 16px; border-radius: 999px;
  }

  /* Hero */
  .hero {
    background: linear-gradient(135deg, var(--dark) 0%, var(--teal) 100%);
    color: #fff; padding: 64px 0 72px;
  }
  .hero h1 { font-size: 34px; font-weight: 800; letter-spacing: -0.5px; }
  .hero p.sub { font-size: 17px; color: var(--muted); max-width: 620px; }
  .btn {
    display: inline-block; text-decoration: none; cursor: pointer;
    background: linear-gradient(135deg, var(--teal-bright), var(--teal));
    color: #fff; font-weight: 800; font-size: 16px;
    padding: 15px 30px; border-radius: 999px; border: 0;
    box-shadow: 0 8px 24px rgba(11,61,46,0.25);
  }
  .hero .btn { background: #fff; color: var(--dark); margin-top: 8px; }
  .hero .note { font-size: 13px; color: var(--muted); margin-top: 14px; }

  /* Steps */
  .steps { display: grid; gap: 16px; margin-top: 24px; }
  .step {
    background: #f6faf8; border: 1px solid #e2efe8; border-radius: 14px;
    padding: 20px; display: flex; gap: 14px; align-items: flex-start;
  }
  .step .num {
    flex: 0 0 32px; width: 32px; height: 32px; border-radius: 50%;
    background: linear-gradient(135deg, var(--dark), var(--teal));
    color: #fff; font-weight: 800; display: flex; align-items: center; justify-content: center;
  }
  .step h3 { font-size: 16px; margin: 2px 0 4px; }
  .step p { margin: 0; font-size: 14px; color: #475569; }

  /* Cards */
  .cards { display: grid; gap: 16px; margin-top: 24px; }
  .card {
    background: var(--card); border: 1px solid #e6ece9; border-radius: 16px;
    padding: 24px; box-shadow: 0 1px 3px rgba(15,23,42,0.05);
  }
  .card h3 { font-size: 18px; }
  .card p { font-size: 14px; color: #475569; margin: 0; }
  .card .tag {
    display: inline-block; font-size: 11px; font-weight: 800; letter-spacing: .06em;
    text-transform: uppercase; color: var(--teal);
    background: #e7f4ee; padding: 4px 10px; border-radius: 999px; margin-bottom: 12px;
  }

  /* Why WhatsApp */
  .why { background: linear-gradient(135deg, var(--dark) 0%, var(--teal) 100%); color: #fff; }
  .why h2 { color: #fff; }
  .why ul { list-style: none; padding: 0; margin: 16px 0 0; display: grid; gap: 12px; }
  .why li { padding-left: 28px; position: relative; color: var(--muted); font-size: 15px; }
  .why li:before {
    content: ""; position: absolute; left: 0; top: 7px; width: 14px; height: 14px;
    border-radius: 50%; background: #fff;
    box-shadow: inset 0 0 0 4px var(--teal);
  }
  .why li strong { color: #fff; }

  /* Signup */
  .signup { background: #f6faf8; }
  .form-card {
    background: #fff; border: 1px solid #e6ece9; border-radius: 18px;
    padding: 24px; max-width: 520px; margin: 24px auto 0;
    box-shadow: 0 10px 30px rgba(11,61,46,0.08);
  }
  .field { margin-bottom: 14px; }
  label { display: block; font-size: 13px; font-weight: 700; margin-bottom: 6px; color: #334155; }
  input, select {
    width: 100%; padding: 13px 14px; font-size: 16px; color: var(--ink);
    border: 1px solid #cbd5e1; border-radius: 10px; background: #fff;
    font-family: inherit;
  }
  input:focus, select:focus { outline: 2px solid var(--teal); outline-offset: 1px; border-color: var(--teal); }
  .form-card .btn { width: 100%; margin-top: 6px; }
  .form-status { margin-top: 14px; font-size: 14px; font-weight: 700; min-height: 20px; }
  .form-status.success { color: var(--teal); }
  .form-status.error { color: #b91c1c; }

  /* Footer */
  footer { background: var(--dark); color: var(--muted); padding: 32px 0; font-size: 14px; }
  footer .wrap { display: flex; flex-direction: column; gap: 12px; align-items: center; text-align: center; }
  footer a { color: #fff; text-decoration: none; font-weight: 700; }
  footer a:hover { text-decoration: underline; }
  .footer-brand { display: flex; align-items: center; gap: 10px; color: #fff; font-weight: 800; }

  @media (min-width: 720px) {
    .hero { padding: 92px 0 104px; }
    .hero h1 { font-size: 52px; }
    .hero p.sub { font-size: 19px; }
    h2 { font-size: 32px; }
    section { padding: 76px 0; }
    .steps { grid-template-columns: repeat(2, 1fr); }
    .cards { grid-template-columns: repeat(3, 1fr); }
    footer .wrap { flex-direction: row; justify-content: space-between; text-align: left; }
  }
</style>
</head>
<body>

  <nav class="nav">
    <div class="wrap">
      <div class="brand">${LOGO_SVG}<span>Relay</span></div>
      <a class="nav-cta" href="#signup">Get Early Access</a>
    </div>
  </nav>

  <header class="hero">
    <div class="wrap">
      <h1>Take WhatsApp orders automatically.</h1>
      <p class="sub">Relay turns your customers' WhatsApp messages into confirmed, priced and invoiced orders — for Nigerian wholesalers, restaurants and dropshippers. No app, no forms, no new habit for your buyers.</p>
      <a class="btn" href="#signup">Get Early Access</a>
      <p class="note">Free during early access. We will reach out on WhatsApp.</p>
    </div>
  </header>

  <section id="how">
    <div class="wrap">
      <h2>How it works</h2>
      <p>Everything happens inside the WhatsApp chat your customers already use.</p>
      <div class="steps">
        <div class="step">
          <div class="num">1</div>
          <div><h3>Customer messages your WhatsApp number</h3><p>They order the way they already do — in plain language, no app to download.</p></div>
        </div>
        <div class="step">
          <div class="num">2</div>
          <div><h3>AI parses the order</h3><p>Products, quantities and delivery details are extracted automatically from the message.</p></div>
        </div>
        <div class="step">
          <div class="num">3</div>
          <div><h3>Supplier and credit checked</h3><p>Stock and credit limits are verified against your catalog and supplier terms.</p></div>
        </div>
        <div class="step">
          <div class="num">4</div>
          <div><h3>Order confirmed and invoiced</h3><p>A confirmation, invoice and secure payment link are sent back — all in WhatsApp.</p></div>
        </div>
      </div>
    </div>
  </section>

  <section id="who" style="background:#ffffff;">
    <div class="wrap">
      <h2>Who it's for</h2>
      <p>Built for the way Nigerian B2B ordering actually happens.</p>
      <div class="cards">
        <div class="card">
          <span class="tag">Dropshippers</span>
          <h3>Dropshippers</h3>
          <p>Take orders from your customers and pass them to suppliers automatically, without copy-pasting between chats.</p>
        </div>
        <div class="card">
          <span class="tag">Restaurants</span>
          <h3>Restaurants</h3>
          <p>Receive supply and bulk orders on WhatsApp, with kitchen tickets and confirmations routed to the right team.</p>
        </div>
        <div class="card">
          <span class="tag">Wholesale / B2B</span>
          <h3>B2B &amp; Wholesale suppliers</h3>
          <p>Let buyers reorder from your catalog by message, with credit limits and stock checks handled for you.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="why">
    <div class="wrap">
      <h2>Why WhatsApp</h2>
      <p>Ordering tools fail when they ask customers to change their habits. WhatsApp removes that friction.</p>
      <ul>
        <li><strong>No downloads or logins.</strong> Your buyers already have WhatsApp — they do not need another app or password.</li>
        <li><strong>No forms.</strong> Customers order in their own words instead of filling fields on a slow connection.</li>
        <li><strong>Where the conversation already is.</strong> Quotes, confirmations and payment links stay in the same chat as the order.</li>
        <li><strong>Built for mobile data.</strong> Lightweight text messages work reliably where web apps struggle.</li>
      </ul>
    </div>
  </section>

  <section id="signup" class="signup">
    <div class="wrap">
      <h2 style="text-align:center;">Get early access</h2>
      <p style="text-align:center;">Tell us about your business and we will set you up for a walkthrough.</p>
      <form id="lead-form" class="form-card" novalidate>
        <div class="field">
          <label for="business_name">Business name</label>
          <input id="business_name" name="business_name" type="text" autocomplete="organization" required>
        </div>
        <div class="field">
          <label for="whatsapp_number">WhatsApp number</label>
          <input id="whatsapp_number" name="whatsapp_number" type="tel" inputmode="tel" autocomplete="tel" placeholder="e.g. 2348090000000" required>
        </div>
        <div class="field">
          <label for="business_category">Business type</label>
          <select id="business_category" name="business_category" required>
            <option value="dropshipper">Dropshipper</option>
            <option value="restaurant">Restaurant</option>
            <option value="b2b">B2B / Wholesale supplier</option>
          </select>
        </div>
        <div class="field">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email" placeholder="you@business.com" required>
        </div>
        <button class="btn" type="submit">Request Early Access</button>
        <div id="form-status" class="form-status" role="status" aria-live="polite"></div>
      </form>
    </div>
  </section>

  <footer>
    <div class="wrap">
      <div class="footer-brand">${LOGO_SVG}<span>Relay</span></div>
      <div>
        <a href="/privacy-policy">Privacy Policy</a>
        &nbsp;&middot;&nbsp;
        <a href="mailto:hello@relay.example">hello@relay.example</a>
      </div>
    </div>
  </footer>

<script>
  (function () {
    var form = document.getElementById('lead-form');
    var statusEl = document.getElementById('form-status');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      statusEl.className = 'form-status';
      statusEl.textContent = 'Sending...';
      var payload = {
        business_name: document.getElementById('business_name').value,
        whatsapp_number: document.getElementById('whatsapp_number').value,
        business_category: document.getElementById('business_category').value,
        email: document.getElementById('email').value
      };
      fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      }).then(function (result) {
        if (result.ok && result.body && result.body.success) {
          form.reset();
          statusEl.className = 'form-status success';
          statusEl.textContent = 'Thanks! We received your details and will reach out on WhatsApp soon.';
        } else {
          statusEl.className = 'form-status error';
          statusEl.textContent = (result.body && result.body.error) ? result.body.error : 'Something went wrong. Please try again.';
        }
      }).catch(function () {
        statusEl.className = 'form-status error';
        statusEl.textContent = 'Network error. Please try again.';
      });
    });
  })();
</script>
</body>
</html>`;

const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Relay — Privacy Policy</title>
<style>
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  background: #0B3D2E; color: #e6efe9; line-height: 1.7; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 48px 20px 72px; }
  h1 { color: #fff; font-size: 30px; margin: 0 0 8px; }
  h2 { color: #fff; font-size: 18px; margin: 28px 0 6px; }
  a { color: #7fe3b4; }
  .brand { color: #fff; font-weight: 800; font-size: 20px; margin-bottom: 24px; }
  .updated { color: #9db3a8; font-size: 13px; margin-bottom: 32px; }
  table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border: 1px solid #1d4a3a; }
  th { background: #123f30; }
  ul { padding-left: 20px; }
  li { margin-bottom: 6px; }
  .contact-box { margin-top: 10px; padding: 14px 16px; border: 1px solid #1d4a3a; border-radius: 8px; background: #123f30; }
  </style>
  </head>
  <body>
  <div class="wrap">
  <div class="brand">Relay</div>
  <h1>Privacy Policy</h1>
  <div class="updated">Last updated: September 17, 2026</div>

  <p>Relay ("Relay", "we", "us", or "our") provides a WhatsApp-based ordering platform that lets businesses receive, process, and confirm customer and supplier orders through WhatsApp messaging. This policy explains what information we collect, how we use it, and the choices available to you.</p>

  <h2>1. Who this policy covers</h2>
  <ul>
  <li><strong>Business clients</strong> — companies that use Relay to run their order-taking on WhatsApp.</li>
  <li><strong>Customers</strong> — people who message a Relay-powered WhatsApp number to place an order with one of our business clients.</li>
  <li><strong>Suppliers</strong> — people or businesses who receive and confirm orders through Relay on behalf of a business client.</li>
  <li><strong>Prospective clients</strong> — people who submit the early-access form on this site.</li>
  </ul>

  <h2>2. Information we collect</h2>
  <table>
  <tr><th>Category</th><th>Examples</th></tr>
  <tr><td>Early-access signups</td><td>Business name, WhatsApp number, business category, and email address submitted through our website form.</td></tr>
  <tr><td>WhatsApp messaging data</td><td>Phone number, message content, message timestamps, and delivery/read status, received via the WhatsApp Business Platform (Meta).</td></tr>
  <tr><td>Order information</td><td>Products ordered, quantities, prices, delivery location, payment status, and order history.</td></tr>
  <tr><td>Business account information</td><td>Business name, business category, operations and kitchen contact numbers, and settlement/payout details provided by our business clients.</td></tr>
  <tr><td>Payment information</td><td>Payment status and transaction references from our payment processor (Monnify). We do not store full card or bank credentials ourselves.</td></tr>
  <tr><td>Conversation state</td><td>The current stage of an in-progress order (e.g. awaiting confirmation), stored temporarily to allow multi-step conversations.</td></tr>
  </table>

  <h2>3. How we use this information</h2>
  <ul>
  <li>To respond to early-access requests and set up onboarding walkthroughs.</li>
  <li>To receive, parse, and process orders sent via WhatsApp, including using automated natural-language parsing to interpret order messages.</li>
  <li>To match orders to the correct business, product, and supplier.</li>
  <li>To send order confirmations, invoices, and payment links back to the relevant customer or supplier over WhatsApp.</li>
  <li>To notify business operations contacts of new or pending orders.</li>
  <li>To maintain order history and basic reporting for our business clients.</li>
  <li>To troubleshoot, secure, and improve the reliability of the platform.</li>
  </ul>
  <p>We do not sell personal information, and we do not use customer or supplier messaging data for advertising.</p>

  <h2>4. How information is processed and stored</h2>
  <ul>
  <li>Messages are received and sent through the WhatsApp Business Platform, operated by Meta, subject to Meta's own terms and policies.</li>
  <li>Order content is parsed using an AI language model to extract structured order details (such as product name and quantity) from natural-language messages.</li>
  <li>Order, client, supplier, and product data is stored in a hosted database with access restricted to Relay's operating infrastructure.</li>
  <li>Payment status is processed through our payment partner, Monnify, which handles payment collection directly.</li>
  </ul>

  <h2>5. Data sharing</h2>
  <ul>
  <li>With the specific business client an order belongs to (a business only sees its own orders and customers, not other businesses' data).</li>
  <li>With Meta, as the operator of the WhatsApp Business Platform used to send and receive messages.</li>
  <li>With our payment processing partner, to facilitate order payment.</li>
  <li>Where required by law, or to protect the rights, safety, or property of Relay, our clients, or the public.</li>
  </ul>

  <h2>6. Data retention</h2>
  <p>We retain order and messaging data for as long as reasonably necessary to provide the service, maintain accurate business records, and meet legal or accounting obligations. Business clients may request deletion of their account data, subject to any records we are required to keep by law.</p>

  <h2>7. Your choices</h2>
  <ul>
  <li>Customers and suppliers can stop messaging a Relay-powered WhatsApp number at any time to end an interaction.</li>
  <li>You may request access to, correction of, or deletion of your personal information by contacting us using the details below.</li>
  <li>Business clients can request an export or deletion of their business's stored data.</li>
  </ul>

  <h2>8. Children's privacy</h2>
  <p>Relay is intended for business use and is not directed at children. We do not knowingly collect personal information from children.</p>

  <h2>9. Changes to this policy</h2>
  <p>We may update this policy from time to time. Material changes will be reflected by updating the "Last updated" date above.</p>

  <h2>10. Contact</h2>
  <div class="contact-box">
  <p style="margin:0">Questions or data requests? Email <a href="mailto:amramgadzama7@yahoo.com">amramgadzama7@yahoo.com</a>.</p>
  </div>

  <p style="margin-top:32px"><a href="/">&larr; Back to Relay</a></p>
  </div>
  </body>
  </html>`;
router.get('/', (req, res) => {
  res.status(200).type('html').send(LANDING_HTML);
});

router.get('/privacy-policy', (req, res) => {
  res.status(200).type('html').send(PRIVACY_HTML);
});

module.exports = router;
module.exports.LANDING_HTML = LANDING_HTML;
