# Manual QA Checklist — WhatsApp Order Pipeline (live sandbox)

Run this by hand against a **live** deployment (Supabase + a real WhatsApp Business
Cloud API number with the app's webhook subscribed). Do **not** push "fix" triggers
to the live DB while running this unless a step says so; use `npm run seed` against
the sandbox project only.

> Status of what you are validating: the shipped stack is (a) three-category order
> pipeline (dropshipper / restaurant / b2b) with confirm/cancel, (b) rejection at
> each validation stage, (c) supplier-response timeout nudges, (d) Monnify payment
> webhook, (e) seller `READY <ref>` / `PROGRESS <ref>` text commands, and (f) the
> per-client daily summary job (`db.getDailySummary` + `src/services/dailySummaryService.js`,
> query = active statuses in the local-midnight window: order count, sum of
> `total_amount`, `payment_status='pending'` count, and best seller by units sold).

---

## 0. Pre-flight

1. App running: `npm start` with real `.env` (Supabase live, `WHATSAPP_*`,
   `MONNIFY_API_KEY`, `MONNIFY_SECRET_KEY`, `APP_BASE_URL`).
2. Meta → your WhatsApp Business → Webhooks: subscribed to **messages**, callback
   `https://<host>/api/webhook`, verify token matches `WHATSAPP_VERIFY_TOKEN`.
   - Test the handshake yourself: `curl "https://<host>/api/webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=CHALLENGE"` → returns `CHALLENGE`.
3. Seeds / tenants (numbers below are placeholders — use your testing numbers):
   - **Default b2b** `Golden Tea Co` — business line `234900000003` (owner), ops
     contact `2348111111111`, seeded products with stock.
   - **Dropshipper** `SkyDeal` — onboard:
     `node scripts/onboardClient.js --name SkyDeal --phone 2349090000001 --category dropshipper`
     then add a supplier + product via SQL (supplier must have a WhatsApp `contact_phone`):
     ```sql
     INSERT INTO suppliers (client_id, name, contact_email, contact_phone, credit_limit, outstanding_balance, can_request_credit)
     VALUES ('<dropshipper client_id>', 'Skyline Supplies', 'sky@x.com', '2349111000111', 50000, 0, true);
     INSERT INTO products (client_id, name, sku, price, stock_quantity)
     VALUES ('<dropshipper client_id>', 'Red Handbag', 'RB-01', 35000, 20);
     ```
   - **Restaurant** `Jollof Corner` — onboard:
     `node scripts/onboardClient.js --name "Jollof Corner" --phone 2349090000002 --category restaurant`
     then enable the kitchen line and a menu with categories:
     ```sql
     UPDATE clients SET kitchen_contact_phone = '2349111000222' WHERE id = '<restaurant client_id>';
     INSERT INTO products (client_id, name, sku, price, stock_quantity, category)
     VALUES ('<restaurant client_id>', 'Jollof Rice', 'JR-1', 3000, 50, 'Meals'),
            ('<restaurant client_id>', 'Fried Rice',  'FR-1', 3200, 50, 'Meals');
     ```
4. Contact map for this run (each actor texts the **business number** of that tenant):

   | Actor | Number | Tenant |
   |---|---|---|
   | Customer CUST | `234999000001` | all |
   | Seller/owner | `234900000003` | b2b Golden Tea |
   | Seller/owner | `2349090000001` | dropshipper SkyDeal |
   | Seller/owner | `2349090000002` | restaurant Jollof |
   | Ops contact | `2348111111111` | b2b Golden Tea |
   | Supplier | `2349111000111` | dropshipper SkyDeal |
   | Kitchen | `2349111000222` | restaurant Jollof |

   > **Why this works**: the webhook resolves the tenant from the incoming
   > `display_phone_number` (the business line); then the sender is disambiguated —
   > Rule 0 owner `READY/PROGRESS`, Rule 1 awaiting supplier YES/NO, Rule 2 customer
   > confirm/cancel, Rule 3 new order. Same bot, so supplier, seller, ops and kitchen
   > all reply on the same business line the customer used.

---

## 1. Dropshipper — full E2E (SkyDeal, business line `2349090000001`)

### 1a. Customer places + cancels at confirmation
1. **CUST → business line:** `I want to order a red handbag`
   - **Expect back** (confirmation prompt): `📋 Please confirm your order: ... 1x Red Handbag ... Total: ₦35000.00 / Reply YES to confirm or NO to cancel.`
   - Check: order held in `awaiting_confirmation`; **no** order row yet (SQL: `SELECT count(*) FROM orders WHERE customer_phone='234999000001'` unchanged).
2. **CUST replies:** `NO`
   - **Expect back:** `Order cancelled. Send a new order anytime.` — held order discarded.

### 1b. Customer places + confirms
3. **CUST → business line:** `Red handbag, 1`
   - **Expect back:** the confirmation prompt (as 1a).
4. **CUST replies:** `YES`
   - **Expect back to CUST:** `✅ Order confirmed! ... • 1 x Red Handbag ... Total: ₦35000.00 / Order ID: ord-… / 🧾 Invoice: https://<host>/api/invoices/ord-… / Pay here: https://…` (status `pending_supplier_confirmation`).
   - **Expect to SUPPLIER** (`2349111000111`): `📦 SUPPLIER ORDER #ORD-XXXX (ord-…) … Reply YES to confirm fulfillment or NO to decline.`
   - SQL: order row status = `pending_supplier_confirmation`, `payment_transaction_reference` non-null, stock decremented, supplier balance debited by 35000.
5. **SUPPLIER replies (ambiguous first — timeout & cancel path later):** `maybe`
   - **Expect to SUPPLIER:** `Please reply YES to confirm or NO to decline order #ORD-XXXX.` — order still `pending_supplier_confirmation`.

### 1c. Supplier confirms
6. **SUPPLIER replies:** `YES`
   - **Expect to SUPPLIER:** `✅ Thanks — order #ORD-XXXX confirmed. We'll let the customer know.`
   - **Expect to CUST:** `✅ Supplier confirmed your order! … Order #ORD-XXXX … We're preparing it — you'll get the payment link when it's ready.`
   - **Expect to SELLER (business line, `2349090000001`):** `📦 Order #ORD-XXXX (ord-…) … Supplier confirmed this order. Reply PROGRESS ORD-XXXX once it starts being prepared, or READY ORD-XXXX when it's ready for the customer.`
   - SQL: status = `supplier_confirmed`.

### 1d. Seller milestones (Rule 0, from the owner number)
7. **SELLER:** `PROGRESS ORD-XXXX`
   - **Expect to CUST:** `🍳 Your order is being prepared! … Order #ORD-XXXX … We'll let you know when it's ready.`
   - **Expect to SELLER:** `✅ Order #ORD-XXXX marked in progress — customer notified.`
   - SQL: status = `in_progress`.
8. **SELLER repeats:** `PROGRESS ORD-XXXX`
   - **Expect to SELLER only:** `ℹ️ Order #ORD-XXXX is already in progress.` — no second customer milestone.
9. **SELLER:** `READY ORD-XXXX`
   - **Expect to CUST:** `🎉 Your order is ready! … Order #ORD-XXXX / Total: ₦35000.00 / Pay here: <link>` (payment link ships **now**).
   - **Expect to SELLER:** `✅ Order #ORD-XXXX marked ready — customer notified.`
   - SQL: status = `ready_for_customer`.

### 1e. Payment (Section 5 covers the webhook call in detail)
10. After step 9, fire the webhook (Section 5). **Expect to CUST:** `💳 Payment received! … Amount paid: ₦35000.00 …` and SQL `payment_status='paid'`. Repeat the call → `already_paid`, no second message.

---

## 2. Dropshipper — supplier cancels / times out

### 2a. Supplier declines (can be done with a second order or by re-running 1b on a fresh order)
- **SUPPLIER replies `NO`** to a fresh `pending_supplier_confirmation` order:
  - **Expect to SUPPLIER:** `OK — order #… marked as declined.`
  - **Expect to CUST:** `❌ The supplier couldn't fulfill order #… at this time. Please send a new order or contact the business.`
  - SQL: status = `supplier_declined`.

### 2b. Timeout scenario (nudge → escalate)
1. Create an order and leave it in `pending_supplier_confirmation`. In live SQL, backdate it past the window:
   ```sql
   UPDATE orders SET created_at = now() - interval '5 hours' WHERE id = '<order id>';
   ```
   (window = `SUPPLIER_RESPONSE_TIMEOUT_HOURS`, default `4`; in sandbox you may
   instead set the env to a tiny value and restart.)
2. Wait for the cron (default hourly) or invoke the job directly:
   `node -e "require('./src/services/supplierResponseTimeout').runSupplierTimeoutJob()"` (with `SUPPLIER_NUDGES_ENABLED` unset/true).
   - **Expect to SUPPLIER:** `⏰ Still waiting on order #… … Reply YES to confirm fulfillment or NO to decline.` — SQL `supplier_nudged_at` set.
   - **Expect:** re-running the job does **not** nudge again (dedup).
3. Backdate to 2× window (e.g. `interval '9 hours'`), run again:
   - **Expect to SELLER:** `🚨 Supplier hasn't responded to order #… … You may want to contact them directly or cancel/redirect this order.` — SQL `supplier_escalated_at` set. Order stays `pending_supplier_confirmation` until the supplier replies.

---

## 3. Restaurant — full E2E (Jollof Corner, business line `2349090000002`)

1. **CUST → business line:** `I want 1 jollof rice for delivery to Ikeja`
   - **Expect back:** confirmation prompt including `delivery: Ikeja`. (If the parsed product name is a stock item, you get the prompt; you may need to match a seeded product name exactly.)
2. **CUST replies:** `YES`
   - **Expect to CUST:** `✅ Order confirmed! …` (order `approved`, kitchen notification-only — no reply needed).
   - **Expect to KITCHEN** (`2349111000222`): `👨🍳 KITCHEN TICKET #ORD-… (ord-…) … Items: • 1x Jollof Rice … Type: DELIVERY … Total: ₦3000.00`.
   - SQL: order `approved`.
3. **SELLER:** `PROGRESS ORD-XXXX` → customer milestone + `in_progress` (as 1d.7).
4. **SELLER:** `READY ORD-XXXX` → customer `🎉 Your order is ready!` with payment link; `ready_for_customer`.
5. Fire the payment webhook (Section 5) → customer `💳 Payment received!`.

### 3b. Restaurant cancel
- Start an order (get the confirmation prompt), reply `NO` → `Order cancelled. Send a new order anytime.` (same as 1a).

### 3c. Restaurant stock-out with alternatives
1. Set stock to 0 (SQL) for a categorized product, e.g. `UPDATE products SET stock_quantity=0 WHERE name='Jollof Rice';`.
2. **CUST:** order that product.
   - **Expect to CUST** (NOT a flat rejection):
     `❌ Sorry, "Jollof Rice" is out of stock right now. … You might like one of these instead: • Fried Rice — ₦3200.00 … Send a new order anytime.`
   - SQL: no order row (rejected at validation, alternatives attached). Restore stock afterwards.

---

## 4. B2B — full E2E (Golden Tea Co, business line `234900000003`)

1. **CUST → business line:** `2 chamomile tea` (use a seeded product name)
   - **Expect back:** confirmation prompt.
2. **CUST replies:** `YES`
   - **Expect to CUST:** `✅ Order confirmed! …`
   - Because this client has an **ops contact**, the order is created as **`pending_ops_confirmation`**.
   - **Expect to OPS** (`2348111111111`): `📦 OPS TICKET #ORD-… Order submitted — awaiting stock confirmation. … Confirm stock availability for this order.`
   - SQL: status = `pending_ops_confirmation`.
3. **OPS replies `YES`** (Rule 1b, anchored: sender == that client's ops contact + an awaiting `pending_ops_confirmation` order, oldest first):
   - **Expect to OPS:** `✅ Thanks — order #… confirmed. We'll let the customer know.`
   - **Expect to CUST:** `✅ Your order is confirmed! … We'll let you know when it's ready.` (no payment link yet)
   - **Expect to SELLER (business line):** the `📦 Order #… Reply PROGRESS … or READY …` prompt.
   - SQL: status = `approved`.
4. **SELLER:** `READY ORD-XXXX` → customer `🎉 Your order is ready!` + payment link; `ready_for_customer`.
5. **OPS declines (variant, second order):**
   - **OPS replies `NO`** → `OK — order #… marked as declined.`; CUST gets `❌ The business couldn't fulfill order #…`; SQL `ops_declined` (not releaseable — `READY` → `not_found`).
   - **OPS replies anything else** (e.g. `maybe`) → re-prompt `Please reply YES to confirm stock or NO to decline order #…`, order stays `pending_ops_confirmation`.
6. Fire the payment webhook (Section 5) → `💳 Payment received!`.
7. **B2B cancel:** start an order, reply `NO` → `Order cancelled. Send a new order anytime.`

---

## 5. Payment webhook call (simulated Monnify callback)

Target: `POST https://<host>/api/monnify/webhook`. The signature is
`HMAC-SHA512` of the **raw** request body keyed by `MONNIFY_SECRET_KEY`.

1. Grab the order's `payment_transaction_reference` from SQL
   (e.g. `MTR-12345678`). Build the body:
   ```json
   {
     "eventType": "SUCCESSFUL_TRANSACTION",
     "data": {
       "transactionReference": "MTR-12345678",
       "paymentStatus": "PAID",
       "amountPaid": 35000.00,
       "settlementAmount": 35000.00,
       "paymentMethod": "ACCOUNT_TRANSFER",
       "paidOn": "2026-09-09T10:30:00.000Z"
     }
   }
   ```
2. Sign + send (same raw bytes for signing and body; adjust `PAYLOAD_FILE`/fields as needed):
   ```bash
   python3 - <<'PY'
   import hmac, hashlib, json
   from pathlib import Path
   body = { ... }  # exact JSON above
   raw = json.dumps(body).encode()
   Path('/tmp/monnify_body.json').write_bytes(raw)
   sig = hmac.new(b"<MONNIFY_SECRET_KEY>", raw, hashlib.sha512).hexdigest()
   print(sig)
   PY
   curl -X POST https://<host>/api/monnify/webhook \
     -H 'Content-Type: application/json' \
     -H "monnify-signature: <sig>" \
     --data-binary @/tmp/monnify_body.json
   ```
   - **Expect:** HTTP 200 `{"success":true,"status":"paid","order_id":"ord-…"}` and **CUST gets** `💳 Payment received! … Amount paid: ₦35000.00 …`.
   - SQL: `payment_status='paid'`.
3. Repeat the same call → `{"success":true,"status":"already_paid"}` and **no** second customer message (idempotent).
4. Tamper tests:
   - Wrong signature → HTTP 401, nothing changes.
   - Right signature, `paymentStatus: "FAILED"` (or wrong `eventType`) → HTTP 200 `{"status":"ignored"}`, nothing changes.
   - `transactionReference` unknown → HTTP 200 `{"status":"ignored_no_order"}`.
   - `amountPaid` ≠ `total_amount` → HTTP 200 `{"status":"amount_mismatch"}`, order stays `pending`.
   - Drop the `monnify-signature` header → HTTP 401.

---

## 6. Regression glance at the cross-cutting jobs

1. **Daily summary** — set a client's time to ~1–2 minutes ahead of now:
   ```sql
   UPDATE clients SET daily_summary_time = to_char(now() + interval '1 minute','HH24:MI');
   ```
   Wait one cron tick (default `* * * * *`).
   - **Expect to the OWNER** (client's `whatsapp_number`):
     `📊 Daily summary — <business>` + that day's `Orders: n / Revenue: ₦… / Best seller: … / Unpaid orders: n`.
   - Re-run / next minute: **no duplicate** (one per client per day).
2. **Seller command negatives** (any tenant, from a non-owner number):
   `READY ORD-XXXX` or `PROGRESS ORD-XXXX` from CUST → consumed as `unauthorized`, order unchanged, and CUST gets **no** early-payment/false receipt.
3. **Confirmation expiry** — leave a held order untouched; after 30 minutes a `YES` is treated as a **new** order (state expired), not a confirm.

---

## 7. Pass / fail log

Copy the table to your QA ticket and tick each row.

| # | Scenario | Expected | Actual | PASS/FAIL |
|---|---|---|---|---|
| 1a | Dropship order → cancel | prompt, then `Order cancelled.` | | |
| 1b | Dropship order → confirm | `✅ Order confirmed!`, supplier asked, stock/balance updated | | |
| 1c | Supplier `YES` | conf to CUST, prompt to SELLER | | |
| 1d | `PROGRESS` → `READY` | milestones + payment link at READY | | |
| 1e/5 | Webhook PAID | `paid`, `💳 Payment received!`, idempotent | | |
| 2a | Supplier `NO` | `supplier_declined`, CUST told | | |
| 2b | Timeout nudge + escalate | nudge once → escalate to SELLER | | |
| 3 | Restaurant full E2E + cancel | kitchen ticket, approve, milestones, paid | | |
| 3c | Restaurant stock-out | alternatives message, no order row | | |
| 4 | B2B full E2E + cancel | ops ticket, ops YES→approved→READY→paid; `NO`→`ops_declined` | | |
| 4⚠ | Ops anchored disambiguation | YES/NO/ambiguous only from that client's ops contact | | |
| 5 | Bad signature / ignored / mismatch | 401 / ignored / amount_mismatch | | |
| 6 | Daily summary + seller negatives | one summary/day; `unauthorized` consumed | | |