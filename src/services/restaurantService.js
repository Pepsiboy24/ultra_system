/**
 * Restaurant Service
 *
 * The parallel order flow for clients with business_category = 'restaurant'.
 * This lives NEXT TO (never inside) the b2b/dropshipper pipeline in
 * orderService.js: every branch below is gated on the client's category by
 * whatsappController, so supplier/credit logic is untouched for non-restaurant
 * clients.
 *
 * Flow (customer side):
 *   idle                  -> menu-based AI match -> 'r_awaiting_confirm'
 *   r_awaiting_confirm    -> Confirm/Cancel buttons (or yes/no text)
 *   r_awaiting_fulfillment-> Delivery/Pickup buttons (or text), filtered by
 *                           the client's offers_delivery/offers_pickup
 *   r_awaiting_location   -> text address OR location pin (if pin only, the
 *                           customer is asked once for a landmark)
 *   r_awaiting_landmark   -> landmark/house number follow-up
 *   r_awaiting_name       -> "Should I put this under <profile name>?" Yes/Change
 *                           (skipped for returning customers: name is saved
 *                           per restaurant + phone)
 *   -> order created + kitchen/ops notified + ETA sent to customer.
 *
 * Restaurant categories deliberately have NO payment step: the payment model
 * for walk-in restaurant customers is undecided.
 *
 * Merchant side (sender == operations_contact_phone) commands:
 *   OUT <item>  -> is_available = false
 *   IN <item>   -> is_available = true
 *   CLOSED      -> accepting_orders = false (new orders politely rejected)
 *   OPEN        -> accepting_orders = true
 *   READY <short> -> order -> 'ready_for_customer'; customer told pickup vs
 *                    out for delivery based on orders.order_type.
 *
 * State keys live in conversations.state (r_ prefix keeps them distinct from
 * the b2b 'awaiting_confirmation' flow so the two can never collide). Pending
 * order data is snapshotted in conversations.pending_order_data.
 */

const db = require('../config/db');
const aiService = require('./aiService');
const whatsappService = require('./whatsappService');

// Prep-time constants (named, so the estimate is easy to tune later).
// Base preparation time for a single order.
const BASE_PREP_MINUTES = 20;
// Extra minutes added per order already ahead of this one in the prep queue.
const PER_ORDER_MINUTES = 10;

// Conversation states used by the restaurant flow.
const STATE_AWAITING_CONFIRM = 'r_awaiting_confirm';
const STATE_AWAITING_FULFILLMENT = 'r_awaiting_fulfillment';
const STATE_AWAITING_LOCATION = 'r_awaiting_location';
const STATE_AWAITING_LANDMARK = 'r_awaiting_landmark';
const STATE_RESOLVING_ITEMS = 'r_resolving_items';
const STATE_AWAITING_NAME = 'r_awaiting_name';

const MID_FLOW_STATES = [
  STATE_AWAITING_CONFIRM,
  STATE_AWAITING_FULFILLMENT,
  STATE_AWAITING_LOCATION,
  STATE_AWAITING_LANDMARK,
  STATE_RESOLVING_ITEMS,
  STATE_AWAITING_NAME
];

const FULFILLMENT_YES = ['yes', 'y', 'confirm', 'confirmed'];
const FULFILLMENT_NO = ['no', 'n', 'cancel'];

// Words a customer might use to drop an item they were asked to resolve, rather
// than choosing one of the suggested options.
const RESOLVE_SKIP_WORDS = [
  'none of', 'none', 'skip', 'not any', 'forget it', 'forget',
  'never mind', 'drop it', 'drop that', 'anything else', 'no thanks', 'not this'
];

/**
 * Build a canonical restaurant item row from a menu product + quantity, so the
 * same item shape is used everywhere (held, resolved, finalize) and can be
 * consolidated by product_id.
 */
function canonicalItemFromProduct(product, quantity, modifiers) {
  const itemTotal = parseFloat((Number(product.price) * quantity).toFixed(2));
  return {
    product_id: product.id,
    product_name: product.name,
    quantity,
    unit_price: Number(product.price),
    item_total: itemTotal,
    ...(Array.isArray(modifiers) && modifiers.length ? { modifiers: modifiers.slice(0, 6) } : {})
  };
}

/**
 * Merge ONE addition into an item list by product_id (same dish → add to its
 * quantity). This is the explicit MERGE behavior: resolved alternatives and
 * confirm-stage modifications join the existing pending items — a resolved
 * item is NEVER treated as a fresh order that replaces what was held.
 */
function consolidateItem(items, addition) {
  const out = items.map(i => ({ ...i }));
  const existing = out.find(i => i.product_id === addition.product_id);
  if (existing) {
    existing.quantity = existing.quantity + addition.quantity;
    existing.item_total = parseFloat((existing.unit_price * existing.quantity).toFixed(2));
    if (Array.isArray(addition.modifiers) && addition.modifiers.length) {
      existing.modifiers = [...new Set([...(existing.modifiers || []), ...addition.modifiers])];
    }
    return out;
  }
  out.push({ ...addition });
  return out;
}

function mergeTermsIntoItems(items, additions) {
  let merged = (items || []).map(i => ({ ...i }));
  for (const addition of additions || []) merged = consolidateItem(merged, addition);
  return merged;
}

function recomputeTotal(items) {
  return parseFloat((items || []).reduce((sum, i) => sum + Number(i.item_total || 0), 0).toFixed(2));
}

/**
 * Return the net-added rows between `before` and `after` (for progress copy):
 * newly added items, or increased quantities for consolidated rows.
 */
function itemsDelta(before, after) {
  const out = [];
  for (const a of after || []) {
    const b = (before || []).find(x => x.product_id === a.product_id);
    if (!b) { out.push(a); continue; }
    if (b.quantity !== a.quantity && a.quantity > b.quantity) {
      out.push({ ...a, quantity: a.quantity - b.quantity });
    }
  }
  return out;
}

/**
 * Plan a set of normalized menu terms against this client's menu: matched terms
 * consolidate into held items; ambiguous / no_match terms become unresolved
 * entries queued for clarification (never silently guessed, never silently
 * dropped — see menu-parse three-outcome contract).
 *
 * @param {Array<Object>} heldItems - Already-held canonical items
 * @param {Array<Object>} terms - Normalized terms (aiService.parseRestaurantMenuOrder)
 * @param {Array<Object>} menu - Client menu rows
 * @returns {{ items: Array<Object>, unresolved: Array<Object> }}
 */
function planOrderItems(heldItems, terms, menu) {
  let items = (heldItems || []).map(i => ({ ...i }));
  const unresolved = [];
  for (const term of terms || []) {
    if (term.outcome === 'matched') {
      const product = term.product_id ? menu.find(m => m.id === term.product_id) : null;
      if (product) {
        items = consolidateItem(items, canonicalItemFromProduct(product, term.quantity, term.modifiers));
      } else {
        // Hallucinated/invalid id counts as no_match — surface it, don't drop.
        unresolved.push({ kind: 'no_match', term: term.term, quantity: term.quantity, suggested_category: term.suggested_category || null });
      }
    } else if (term.outcome === 'ambiguous') {
      unresolved.push({ kind: 'ambiguous', term: term.term, quantity: term.quantity, candidates: term.candidates || [], suggested_category: null });
    } else {
      unresolved.push({ kind: 'no_match', term: term.term, quantity: term.quantity, candidates: [], suggested_category: term.suggested_category || null });
    }
  }
  return { items, unresolved };
}

/**
 * The options a customer is shown for one unresolved item (the SPECIFIC
 * options they must answer against — matches are restricted to these):
 *   - ambiguous  -> the candidate menu items the term could mean (<= 3).
 *   - no_match   -> up to 3 available menu items, same category first (the
 *                   same-category alternatives fix for no-match items).
 * Returns [] when nothing sensible can be offered.
 */
async function unresolvedOptions(client, menu, unresolved) {
  if (unresolved.kind === 'ambiguous') {
    return (unresolved.candidates || [])
      .map(id => menu.find(m => m.id === id))
      .filter(Boolean)
      .slice(0, 3)
      .map(p => ({ id: p.id, name: p.name, price: p.price }));
  }
  let pool = menu.filter(p => p.is_available !== false);
  const category = unresolved.suggested_category;
  if (category) {
    const same = pool.filter(p => p.category && String(p.category).toLowerCase() === String(category).toLowerCase());
    if (same.length) pool = same;
  }
  return pool.slice(0, 3).map(p => ({ id: p.id, name: p.name, price: p.price }));
}

/**
 * Normalize free text for matching against resolution options (lowercase,
 * punctuation removed, conversational fluff dropped).
 */
function normalizeMatchText(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9+\s]/g, ' ')
    .replace(/\b(the|a|an|i'll have|i will have|i want|i want to|give me|can i have|can i|one of|one|that one|this one|the one|please|some|now|only|also|and|with|let's|lets|um)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a customer's reply strictly against the SPECIFIC options that were
 * shown for the current unresolved item (Bug 3: never guess among candidates).
 * Returns the matched option, the sentinel string 'ambiguous' when the reply
 * matches more than one shown option (re-ask, do not guess), or null.
 */
function matchResolutionReply(text, options) {
  const opts = options || [];
  const needle = normalizeMatchText(text);
  if (!needle) return null;
  let hit = null;
  for (const opt of opts) {
    const hay = normalizeMatchText(opt.name);
    const matches =
      (opt.id && needle === String(opt.id).toLowerCase()) ||
      hay === needle ||
      (needle.length >= 4 && hay.includes(needle)) ||
      (needle.split(' ').length >= 2 && needle.split(' ').every(w => hay.includes(w)));
    if (matches) {
      if (hit) return 'ambiguous';
      hit = opt;
    }
  }
  return hit;
}

/**
 * Classify a free-text reply at the confirm stage as yes / no / neither.
 * Handles typed prefixes ("yes please", "no thanks", "yes i confirm") without
 * treating product mentions ("yes i want chicken") as a plain confirmation —
 * those still fall through to modification handling.
 */
function classifyConfirmReply(text) {
  const t = String(text || '').toLowerCase().trim().replace(/[.!?]+$/, '');
  if (FULFILLMENT_YES.includes(t) || FULFILLMENT_NO.includes(t)) {
    return FULFILLMENT_YES.includes(t) ? 'yes' : 'no';
  }
  if (/^(yes|y|confirm|confirmed)\b([\s,]+(please|sure|ok|okay|let'?s go))*$/.test(t)) return 'yes';
  if (/^(no|n|cancel)\b([\s,]+(please|thanks|thank you|that'?s all))*$/.test(t) || /^cancel it$/.test(t)) return 'no';
  return null;
}

/**
 * Stale-state guard for rigid fallback messages. A handler re-sends a rigid
 * prompt ("reply with delivery or pickup", "send your address", ...) when the
 * message it received doesn't match what that step expects. But if the
 * conversation has ALREADY moved past that step (e.g. another webhook for the
 * same customer advanced the state while this one was in flight — or an earlier
 * pickup selection was acknowledged and the flow moved on), re-sending the
 * fallback is misleading: the customer already answered.
 *
 * Re-reads the conversation state right now. If it's still `expectedState` the
 * fallback is legitimate and this returns null. If it has moved on, this
 * re-dispatches the message through the state machine with the FRESH state and
 * returns that result — so the customer is never told to replug an answer the
 * flow already has.
 *
 * @param {Object} context - { from, client, messageType, text, buttonReply, location }
 * @param {string} expectedState - The state the stale handler assumed
 * @returns {Promise<Object|null>}
 */
async function reDispatchIfStateMoved(context, expectedState) {
  const fresh = await db.getConversationState(context.from);
  if (fresh && fresh.state && fresh.state !== expectedState) {
    console.log(`♻️ rest: state ${expectedState} → ${fresh.state} for ${context.from}; re-dispatching (stale fallback suppressed).`);
    return handleRestaurantMessage({ ...context, conversation: fresh });
  }
  return null;
}

/**
 * Normalize a phone number (digits only) for sender comparison.
 */
function cleanPhone(num) {
  return String(num || '').replace(/\D/g, '');
}

/**
 * True when `phone` is the client's operations_contact_phone — the ONLY sender
 * allowed to issue merchant commands (OUT/IN/CLOSED/OPEN/READY).
 */
function isRestaurantOpsSender(phone, client) {
  if (!client || !phone) return false;
  return cleanPhone(client.operations_contact_phone) === cleanPhone(phone);
}

/**
 * Which fulfillment options a client currently offers, derived from
 * offers_delivery / offers_pickup.
 * @returns {Array<'delivery'|'pickup'>}
 */
function chooseFulfillment(client) {
  const offers = [];
  if (client.offers_delivery !== false) offers.push('delivery');
  if (client.offers_pickup !== false) offers.push('pickup');
  return offers;
}

/**
 * Compute the queue-aware prep estimate for a restaurant order:
 * base prep time + 10 minutes per order already ahead in the queue. Rounded
 * to the nearest 5 minutes and presented as a range.
 *
 * @param {number} queueAhead - Number of other orders currently in a non-final
 *   state (awaiting preparation) before this one.
 * @returns {{ min: number, max: number, string: string }}
 */
function computeEtaRange(queueAhead) {
  // Cap so one stuck/forgotten order can never produce an absurd promise.
  const MAX_ETA_MINUTES = Number(process.env.MAX_ETA_MINUTES) || 90;
  const eta = Math.min(MAX_ETA_MINUTES, BASE_PREP_MINUTES + (Number(queueAhead) || 0) * PER_ORDER_MINUTES);
  const min = Math.max(5, Math.round(eta / 5) * 5);
  const max = min + 5;
  return { min, max, string: `${min}-${max}` };
}

/**
 * Send a polite "we're closed for orders" message (accepting_orders = false).
 */
async function sendNotAccepting(from) {
  return whatsappService.sendTextMessage(from, whatsappService.buildNotAcceptingOrdersMessage());
}

// ---------------------------------------------------------------------------
// Merchant commands (operations_contact_phone only)
// ---------------------------------------------------------------------------

/**
 * Handle OUT/IN/CLOSED/OPEN/READY merchant commands. Only fires when the
 * sender is the client's operations_contact_phone. Any other text from an ops
 * contact: unless it is a recognized command it is NOT treated as a customer
 * order — the ops contact gets a short command reminder instead.
 *
 * @param {{ from: string, client: Object, text: string }} params
 * @returns {Promise<{ handled: boolean, action?: string, order?: Object|null, reply?: string }>}
 */
async function processMerchantCommand({ from, client, text }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { handled: false };

  const clientId = client.id;

  // READY <short> — same shape as the seller READY command, but sender is the
  // restaurant's operations contact (not the business line).
  const readyMatch = trimmed.match(/^READY\s+([A-Za-z0-9-]{4,40})$/i);
  if (readyMatch) {
    const ref = String(readyMatch[1]).toUpperCase().replace(/\s+/g, '');
    const order = await db.getOrderByShortReference(ref, clientId, ['approved', 'in_progress']);
    if (!order) {
      const reply = `❌ No order #${ref} found that is ready to release.`;
      await whatsappService.sendTextMessage(from, reply);
      return { handled: true, action: 'ready_not_found', order: null, reply };
    }
    await db.updateOrderStatus(order.id, 'ready_for_customer', clientId);
    const shortId = String(order.id).slice(0, 8).toUpperCase();
    if (order.customer_phone) {
      await whatsappService.sendTextMessage(
        order.customer_phone,
        whatsappService.buildRestaurantReadyMessage({ orderId: order.id, orderType: order.order_type })
      );
    }
    const reply = `✅ Order #${shortId} marked ready — customer notified.`;
    await whatsappService.sendTextMessage(from, reply);
    return { handled: true, action: 'ready', order, reply };
  }

  // OUT <item> / IN <item> — toggle menu availability by fuzzy name match.
  const availabilityMatch = trimmed.match(/^(OUT|IN)\s+(.+)$/i);
  if (availabilityMatch) {
    const action = availabilityMatch[1].toLowerCase(); // 'out' | 'in'
    const itemName = availabilityMatch[2].trim();
    const product = itemName ? await db.getProductByName(itemName, clientId) : null;
    if (!product) {
      const reply = `❌ Couldn't find "${itemName}" in your menu.`;
      await whatsappService.sendTextMessage(from, reply);
      return { handled: true, action: `${action}_not_found`, order: null, reply };
    }
    const isAvailable = action === 'in';
    await db.setProductAvailability(product.id, isAvailable, clientId);
    const reply = isAvailable
      ? `✅ "${product.name}" is back ON the menu.`
      : `✅ "${product.name}" is now OFF the menu (unavailable).`;
    await whatsappService.sendTextMessage(from, reply);
    return { handled: true, action: action, order: null, reply };
  }

  // PRICE <item> <amount> — change a menu price without touching the database.
  const priceMatch = trimmed.match(/^PRICE\s+(.+?)\s+₦?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*$/i);
  if (priceMatch) {
    const itemName = priceMatch[1].trim();
    const newPrice = Number(priceMatch[2].replace(/,/g, ''));
    const product = await db.getProductByName(itemName, clientId);
    let reply;
    if (!product) {
      reply = `❌ Couldn't find "${itemName}" in your menu.`;
    } else if (!(newPrice > 0) || newPrice > 10000000) {
      reply = `❌ "${priceMatch[2]}" isn't a valid price.`;
    } else {
      const updated = await db.setProductPrice(product.id, newPrice, clientId);
      reply = updated
        ? `✅ "${product.name}" is now ₦${newPrice.toLocaleString('en-NG', { minimumFractionDigits: 2 })}.`
        : `❌ Couldn't update "${product.name}". Please try again.`;
    }
    await whatsappService.sendTextMessage(from, reply);
    return { handled: true, action: 'price', order: null, reply };
  }

  // INFO <text> — owner-written facts (hours, delivery areas/fees, payment)
  // the bot may quote. "INFO" alone shows what is saved.
  const infoMatch = trimmed.match(/^INFO(?:\s+([\s\S]+))?$/i);
  if (infoMatch) {
    const body = infoMatch[1] ? infoMatch[1].trim() : '';
    let reply;
    if (!body) {
      reply = client.info_text
        ? `ℹ️ Saved info:\n${client.info_text}\n\nTo change it: INFO <new text>  ·  To clear it: INFO CLEAR`
        : `ℹ️ No info saved yet. Send: INFO <opening hours, delivery areas & fees, how customers pay, address>`;
    } else if (/^clear$/i.test(body)) {
      await db.setClientInfoText(clientId, null);
      reply = `✅ Info cleared.`;
    } else if (body.length > 600) {
      reply = `❌ That's ${body.length} characters — please keep it under 600.`;
    } else {
      const saved = await db.setClientInfoText(clientId, body);
      reply = saved
        ? `✅ Saved. The bot will use this when customers ask about hours, delivery or payment.`
        : `❌ Couldn't save that. Please try again.`;
    }
    await whatsappService.sendTextMessage(from, reply);
    return { handled: true, action: 'info', order: null, reply };
  }

  // CLOSED / OPEN — toggle accepting_orders. Note this must run BEFORE the
  // accepting_orders gate so an ops contact can reopen a closed restaurant.
  const openClose = trimmed.match(/^(CLOSED|OPEN)$/i);
  if (openClose) {
    const accepting = openClose[1].toUpperCase() === 'OPEN';
    await db.setClientAcceptingOrders(clientId, accepting);
    const reply = accepting
      ? `✅ Restaurant is now OPEN — accepting new orders.`
      : `✅ Restaurant is now CLOSED — new orders will be politely declined.`;
    await whatsappService.sendTextMessage(from, reply);
    return { handled: true, action: accepting ? 'open' : 'closed', order: null, reply };
  }

  return { handled: false };
}

// ---------------------------------------------------------------------------
// Order creation + notifications
// ---------------------------------------------------------------------------

/**
 * Get the kitchen ticket to a human by every route we have, in order:
 *   1. free-form text to operations_contact_phone (works inside the 24h window)
 *   2. approved template (env KITCHEN_TICKET_TEMPLATE) — works outside 24h
 *   3. the same two tries against kitchen_contact_phone, if different
 * Template body must have 4 variables: {{1}} short id, {{2}} items,
 * {{3}} total, {{4}} "PICKUP"/"DELIVERY" + ETA.
 * Returns { ok, via } and never throws.
 */
async function notifyKitchen(client, pending, order, etaRange) {
  const targets = [];
  const ops = client.operations_contact_phone || pending.ops_contact_phone || null;
  if (ops) targets.push(ops);
  if (client.kitchen_contact_phone && client.kitchen_contact_phone !== ops) targets.push(client.kitchen_contact_phone);
  if (targets.length === 0) return { ok: false, via: 'no_kitchen_number' };

  const ticketText = whatsappService.buildRestaurantTicketMessage({
    order, items: pending.items, total_amount: order.total_amount, etaRange: etaRange.string,
    customerName: pending.customer_name || null
  });
  const shortId = String(order.id).slice(0, 8).toUpperCase();
  const itemsLine = (pending.items || [])
    .map(i => `${i.quantity}x ${i.product_name || i.item_name}`).join(', ');
  const typeLine = (pending.customer_name ? `Customer ${pending.customer_name} · ` : '')
    + `${order.order_type === 'pickup' ? 'PICKUP' : 'DELIVERY'} · ETA ${etaRange.string} min`
    + (order.order_type === 'delivery' && order.delivery_location ? ` · ${order.delivery_location}` : '');

  const templateName = process.env.KITCHEN_TICKET_TEMPLATE;
  const templateLang = process.env.KITCHEN_TICKET_TEMPLATE_LANG || 'en';

  for (const phone of targets) {
    try {
      // Template FIRST when configured. A free-form text to someone outside
      // the 24h window is ACCEPTED by the API and only fails later (status
      // webhook, error 131047) — we can't see that here, so text can't be
      // trusted as the primary route. Templates always deliver.
      if (templateName) {
        const tResult = await whatsappService.sendTemplateMessage(
          phone, templateName, templateLang,
          [shortId, itemsLine, `₦${Number(order.total_amount).toFixed(2)}`, typeLine]
        );
        if (tResult && tResult.success === true) return { ok: true, via: `template:${phone}` };
      }
      const textResult = await whatsappService.sendTextMessage(phone, ticketText);
      if (textResult && textResult.success === true) {
        return { ok: true, via: templateName ? `text:${phone}` : `text-unverified:${phone}` };
      }
    } catch (error) {
      console.error(`❌ notifyKitchen exception for ${phone}: ${error.message}`);
    }
  }
  return { ok: false, via: 'all_routes_failed' };
}

/**
 * Tell the platform operator (ALERT_PHONE) that a kitchen could not be
 * reached, so a human can phone the restaurant. Best-effort; always logged.
 */
async function alertOperator(client, order, customerPhone, pending, reason) {
  const shortId = String(order.id).slice(0, 8).toUpperCase();
  const msg = `🚨 KITCHEN NOT REACHED — ${client.business_name || client.id}\n` +
    `Order #${shortId} · ${(pending.items || []).map(i => `${i.quantity}x ${i.product_name || i.item_name}`).join(', ')}\n` +
    `Total ₦${Number(order.total_amount).toFixed(2)} · ${order.order_type}\n` +
    `Customer: ${customerPhone}\nReason: ${reason}\nPlease contact the restaurant now.`;
  console.error(`🚨 ${msg.replace(/\n/g, ' | ')}`);
  const alertPhone = process.env.ALERT_PHONE;
  if (!alertPhone) return;
  try {
    const templateName = process.env.KITCHEN_TICKET_TEMPLATE;
    let sent = false;
    if (templateName) {
      const t = await whatsappService.sendTemplateMessage(alertPhone, templateName,
        process.env.KITCHEN_TICKET_TEMPLATE_LANG || 'en',
        [shortId, `KITCHEN NOT REACHED: ${client.business_name || ''} / customer ${customerPhone}`, `₦${Number(order.total_amount).toFixed(2)}`, reason]);
      sent = !!(t && t.success === true);
    }
    if (!sent) await whatsappService.sendTextMessage(alertPhone, msg);
  } catch (error) {
    console.error(`❌ alertOperator failed: ${error.message}`);
  }
}

/**
 * Finalize a confirmed restaurant order: create the order row + items, notify
 * the kitchen (operations_contact_phone), and tell the customer the ETA.
 *
 * NO PAYMENT STEP HERE — the restaurant payment model (pay-upfront via
 * Monnify like B2B vs pay-on-delivery handled by the restaurant vs hybrid) has
 * not been decided yet. Do not add one without revisiting the spec below.
 *
 * @param {string} customerPhone
 * @param {Object} client - Restaurant client row
 * @param {Object} pending - Conversation pending_order_data
 * @returns {Promise<{ status: string, order: Object, etaRange: { min: number, max: number, string: string } }>}
 */
async function finalizeRestaurantOrder(customerPhone, client, pending) {
  const clientId = pending.client_id || client.id;
  const fulfillment = pending.fulfillment || 'pickup';
  console.log(`🍳 finalize started (${clientId}, ${customerPhone}): ${fulfillment} · ${(pending.items || []).length} item(s)`);

  // TODO: payment model for restaurant orders not yet decided — see restaurant-flow-walkthrough.md
  // When a payment step is added it belongs here, between creating the order
  // and notifying the kitchen: the customer would pay (upfront) and the
  // kitchen/ETA messages below would only fire on a successful payment. For
  // now, fulfillment + location complete -> straight to kitchen + ETA.

  try {
    // Guarantee the per-client audit placeholder supplier exists (idempotent).
    // Without this, a live client that never went through B2B onboarding has no
    // placeholder supplier row, and createOrder fails with a supplier_id FK
    // violation — which would previously have stranded the conversation at the
    // delivery/pickup step BEFORE this hardening.
    const placeholder = await db.createPlaceholderSupplier(clientId);

    const order = await db.createOrder({
      client_id: clientId,
      supplier_id: placeholder ? placeholder.id : null,
      status: 'approved',
      status_reason: 'Restaurant order confirmed via WhatsApp flow.',
      total_amount: pending.total_amount,
      business_name: pending.business_name || client.business_name || null,
      delivery_location: pending.delivery_location || null,
      customer_phone: customerPhone,
      order_type: fulfillment,
      customer_name: pending.customer_name || null
    });

    // Remember the name for next time (best-effort; never blocks the order).
    if (pending.customer_name) {
      try { await db.saveCustomerName(clientId, customerPhone, pending.customer_name); }
      catch (nameErr) { console.error(`⚠️ saveCustomerName failed: ${nameErr.message}`); }
    }

    await db.createOrderItems(pending.items.map(item => ({
      order_id: order.id,
      product_id: item.product_id,
      quantity: item.quantity,
      unit_price: item.unit_price
    })));

    const queueAhead = await db.countQueueAhead(clientId, order.id);
    const etaRange = computeEtaRange(queueAhead);
    console.log(`🍽️ Order ${order.id} created (${order.order_type}) · queueAhead=${queueAhead} · ETA ${etaRange.string} min`);

    // Kitchen notification — never silent. If no route reaches a human, the
    // customer is NOT told "confirmed with an ETA"; the operator is alerted.
    const kitchen = await notifyKitchen(client, pending, order, etaRange);
    console.log(`👨🍳 Kitchen notification for order ${order.id}: ${kitchen.ok ? `sent via ${kitchen.via}` : `FAILED (${kitchen.via})`}`);
    if (!kitchen.ok) {
      await alertOperator(client, order, customerPhone, pending, kitchen.via);
    }

    // Customer message: ETA only when the kitchen actually has the order.
    const customerBody = kitchen.ok
      ? whatsappService.buildRestaurantEtaMessage({
          order,
          items: pending.items,
          total_amount: order.total_amount,
          etaRange: etaRange.string,
          customerName: pending.customer_name || null
        })
      : `✅ We've received your order #${String(order.id).slice(0, 8).toUpperCase()}! ` +
        `We're confirming it with the kitchen right now and will message you shortly. Thank you for your patience 🙏`;
    const customerResult = await whatsappService.sendTextMessage(customerPhone, customerBody);
    console.log(`📬 Customer message to ${customerPhone}: ${customerResult && customerResult.success === true ? 'sent' : `NOT sent (${JSON.stringify(customerResult)})`}`);

    // State clears ONLY after the order + notifications are complete (or the
    // failure path below releases it explicitly).
    await db.clearConversationState(customerPhone);

    console.log(`🍽️ Restaurant order ${order.id} confirmed (${order.order_type}) — ETA ${etaRange.string} min.`);
    return { status: 'confirmed', order, etaRange };
  } catch (error) {
    // The conversation is released regardless so the customer is NEVER stranded
    // at the delivery/pickup step asking whether they already answered.
    console.error(`❌ Restaurant order finalize FAILED for ${customerPhone}: ${error.message}`);
    console.error(error.stack || error);
    try {
      await db.clearConversationState(customerPhone);
      await whatsappService.sendTextMessage(
        customerPhone,
        `Sorry — something went wrong on our side placing your order. Please send it again and we'll re-run it right away.`
      );
    } catch (cleanupError) {
      console.error(`❌ finalize cleanup ALSO failed for ${customerPhone}: ${cleanupError.message}`);
    }
    return { status: 'finalize_error', error: error.message };
  }
}

// A customer who walks away mid-order must not be trapped in that step forever.
const STATE_TTL_MS = (Number(process.env.RESTAURANT_STATE_TTL_MINUTES) || 45) * 60 * 1000;
const CANCEL_RE = /^\s*(cancel|cancel (it|order|my order)|start over|restart|new order|never ?mind|forget it|stop)\s*[.!]*\s*$/i;
const QUESTION_START_RE = /^\s*(how|what|when|where|why|do|does|can|could|is|are|will|would|which)\b/i;

/**
 * Read a delivery/pickup choice out of free text ("pickup please",
 * "I'll collect it", "deliver it"). Questions ("how long will delivery
 * take?") and messages mentioning both options are NOT choices.
 */
function detectFulfillmentChoice(text) {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) return null;
  if (['delivery', 'deliver', 'deliver to'].includes(lower)) return 'delivery';
  if (['pickup', 'pick up', 'pick it up', 'collect'].includes(lower)) return 'pickup';
  if (lower.includes('?') || QUESTION_START_RE.test(lower)) return null;
  const hasDelivery = /\bdeliver(y|ed)?\b/.test(lower);
  const hasPickup = /\b(pick\s?-?up|pick\s+(it|them|that|this)\s+up|collect|take\s?-?away)\b/.test(lower);
  if (hasDelivery && !hasPickup) return 'delivery';
  if (hasPickup && !hasDelivery) return 'pickup';
  return null;
}

const MENU_REQUEST_RE = /\b(menu|what\s+(do\s+you|can\s+i)\s+(have|sell|offer|get|order)|what('?s|\s+is)\s+(available|on\s+offer)|what\s+food|what\s+dishes)\b/i;
const ORDERISH_RE = /\b(order|add|buy|want|give me|get me|i'?ll have|i'?d like|id like)\b/i;
const VIEWISH_RE = /\b(see|show|send|view|check|look|share|list)\b/i;

/** True when the message is asking to SEE the menu (not placing an order). */
function isMenuRequest(text) {
  const t = String(text || '');
  if (!MENU_REQUEST_RE.test(t)) return false;
  return !(ORDERISH_RE.test(t) && !VIEWISH_RE.test(t));
}

/** Format the available menu, grouped by category, for a WhatsApp text. */
function buildFullMenuMessage(menu) {
  const items = (menu || []).filter(m => m.is_available !== false);
  if (items.length === 0) return null;
  const groups = new Map();
  for (const m of items.slice(0, 40)) {
    const cat = m.category || 'Menu';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(`• ${m.name} — ₦${Number(m.price).toFixed(2)}`);
  }
  const body = [...groups.entries()].map(([cat, lines]) => `*${cat}*\n${lines.join('\n')}`).join('\n\n');
  return `🍽️ Here's our menu:\n\n${body}\n\nJust tell me what you'd like to order!`;
}

/**
 * Secondary check used ONLY when the order parser found zero items: try to
 * answer a genuine question from facts we hold (menu, flags, the customer's
 * recent order with a freshly recomputed ETA). Returns true when an answer
 * was sent; false means the caller should use its existing fallback.
 * Never throws.
 */
async function tryAnswerQuestion(from, client, trimmedText, menu) {
  try {
    if (!trimmedText) return false;

    // Deterministic shortcut: "show me the menu" never needs the AI.
    if (isMenuRequest(trimmedText)) {
      const menuText = buildFullMenuMessage(menu);
      if (menuText) {
        await whatsappService.sendTextMessage(from, menuText);
        return true;
      }
    }

    let recent_order = null;
    const row = await db.getMostRecentOrderForCustomer(from, client.id);
    const ACTIVE = ['approved', 'in_progress', 'ready_for_customer'];
    if (row && ACTIVE.includes(row.status)) {
      const ageMs = Date.now() - new Date(row.created_at).getTime();
      if (ageMs < 4 * 60 * 60 * 1000) {
        const isReady = row.status === 'ready_for_customer';
        let eta_range = null;
        if (!isReady) {
          const queueAhead = await db.countQueueAhead(client.id, row.id);
          eta_range = computeEtaRange(queueAhead).string;
        }
        const lines = await db.getOrderItems(row.id, client.id);
        recent_order = {
          short_id: String(row.id).slice(0, 8).toUpperCase(),
          items: lines.map(i => `${i.quantity}x ${i.product_name}`).join(', ') || 'your items',
          status: row.status,
          is_ready: isReady,
          eta_range
        };
      }
    }

    const context = {
      business_name: client.business_name || 'the restaurant',
      accepting_orders: client.accepting_orders !== false,
      offers_delivery: client.offers_delivery !== false,
      offers_pickup: client.offers_pickup !== false,
      menu: (menu || [])
        .filter(m => m.is_available !== false)
        .map(m => ({ name: m.name, category: m.category, price: m.price })),
      info: client.info_text || null,
      recent_order
    };

    const result = await aiService.answerRestaurantQuestion(trimmedText, context);
    if (result && result.is_question === true && result.answer) {
      await whatsappService.sendTextMessage(from, result.answer);
      return true;
    }
    return false;
  } catch (error) {
    console.error(`❌ tryAnswerQuestion failed (falling back): ${error.message}`);
    return false;
  }
}

const GREETING_RE = /^\s*(hi|hello|hey|hiya|howdy|yo|greetings|good\s+(morning|afternoon|evening))(\s+(there|ma|sir|boss|team))?\s*[!.,]*\s*$/i;
const POST_CANCEL_RE = /^\s*(please\s+)?(i\s*(want|need|would like|'?d like)\s+to\s+)?cancel(\s+(my|the|that|this))?(\s+order)?(\s+please)?\s*[.!]*\s*$/i;

/** Questions/menu requests must never be swallowed as an address or landmark. */
function looksLikeQuestion(text) {
  const t = String(text || '');
  return t.includes('?') || QUESTION_START_RE.test(t) || isMenuRequest(t);
}

/**
 * At free-text steps (delivery address / landmark) a question is answered
 * (or honestly declined) and the step is re-asked, instead of the question
 * being recorded as the address. Returns true when it handled the message.
 */
async function answerIfQuestionAtFreeTextStep(from, client, trimmedText, promptText) {
  if (!trimmedText || !looksLikeQuestion(trimmedText)) return false;
  const menu = await db.getClientMenu(client.id);
  const answered = await tryAnswerQuestion(from, client, trimmedText, menu);
  await whatsappService.sendTextMessage(from, answered ? promptText : `I'm not sure about that one. ${promptText}`);
  return true;
}

const ADDRESS_WORDS_RE = /\b(road|rd|street|avenue|ave|crescent|close|lane|drive|estate|junction|opposite|behind|beside|plaza|church|mosque|school|hotel|filling station|bus stop|area|phase|layout|quarters|gra|extension)\b/gi;

/**
 * Conservative "this is a delivery address" check, used when someone types
 * their address at the delivery/pickup question instead of tapping a button.
 * Needs a house number plus an address word, or two address words.
 */
function looksLikeAddress(text) {
  const t = String(text || '').trim();
  if (t.length < 10 || looksLikeQuestion(t)) return false;
  const words = (t.match(ADDRESS_WORDS_RE) || []).length;
  return (/\d/.test(t) && words >= 1) || words >= 2;
}

function kitchenTargets(client) {
  const ops = client.operations_contact_phone || null;
  const targets = [];
  if (ops) targets.push(ops);
  if (client.kitchen_contact_phone && client.kitchen_contact_phone !== ops) targets.push(client.kitchen_contact_phone);
  return targets;
}

/**
 * Tell the kitchen a confirmed order was cancelled. Uses the optional
 * KITCHEN_CANCEL_TEMPLATE (2 variables: {{1}} order id, {{2}} items) first
 * when set, because plain text only reaches phones that messaged the bot in
 * the last 24h. The NEW-ORDER template must never be reused for this.
 */
async function notifyKitchenCancel(client, order, itemsLine) {
  const targets = kitchenTargets(client);
  if (targets.length === 0) return { ok: false, via: 'no_kitchen_number' };
  const shortId = String(order.id).slice(0, 8).toUpperCase();
  const text = `❌ ORDER CANCELLED by the customer — #${shortId}\n${itemsLine}\nPlease do NOT prepare this order.`;
  const templateName = process.env.KITCHEN_CANCEL_TEMPLATE;
  for (const phone of targets) {
    try {
      if (templateName) {
        const t = await whatsappService.sendTemplateMessage(
          phone, templateName, process.env.KITCHEN_CANCEL_TEMPLATE_LANG || 'en', [shortId, itemsLine]
        );
        if (t && t.success === true) return { ok: true, via: `template:${phone}` };
      }
      const r = await whatsappService.sendTextMessage(phone, text);
      if (r && r.success === true) return { ok: true, via: templateName ? `text:${phone}` : `text-unverified:${phone}` };
    } catch (error) {
      console.error(`❌ notifyKitchenCancel exception for ${phone}: ${error.message}`);
    }
  }
  return { ok: false, via: 'all_routes_failed' };
}

/**
 * Customer says "cancel my order" AFTER confirming (conversation is idle).
 * Only an order the kitchen has not started ('approved') can be cancelled.
 */
async function handleCancelConfirmedOrder({ from, client }) {
  const order = await db.getMostRecentOrderForCustomer(from, client.id);
  const ACTIVE = ['approved', 'in_progress', 'ready_for_customer'];
  const fresh = order && (Date.now() - new Date(order.created_at).getTime()) < 4 * 60 * 60 * 1000;
  if (!order || !fresh || !ACTIVE.includes(order.status)) {
    const reply = `I don't see an active order to cancel. Send me what you'd like to order anytime 😊`;
    await whatsappService.sendTextMessage(from, reply);
    return { handled: true, status: 'cancel_no_active_order', reply };
  }
  const shortId = String(order.id).slice(0, 8).toUpperCase();
  if (order.status !== 'approved') {
    const reply = order.status === 'ready_for_customer'
      ? `Order #${shortId} is already ready, so it can't be cancelled here. Please contact the restaurant directly.`
      : `Order #${shortId} is already being prepared, so it can't be cancelled here. Please contact the restaurant directly.`;
    await whatsappService.sendTextMessage(from, reply);
    return { handled: true, status: 'cancel_too_late', reply };
  }

  await db.updateOrderStatus(order.id, 'cancelled', client.id);
  const lines = await db.getOrderItems(order.id, client.id);
  const itemsLine = (lines || []).map(i => `${i.quantity}x ${i.product_name}`).join(', ') || 'items';
  const kitchen = await notifyKitchenCancel(client, order, itemsLine);
  console.log(`❌ Order ${order.id} cancelled by customer ${from}; kitchen notice: ${kitchen.ok ? `sent via ${kitchen.via}` : `FAILED (${kitchen.via})`}`);
  if (!kitchen.ok) {
    const msg = `🚨 CANCELLATION NOT DELIVERED — ${client.business_name || client.id}\nOrder #${shortId} (${itemsLine}) was cancelled by ${from}, but the kitchen could not be told. Please contact the restaurant.`;
    console.error(msg.replace(/\n/g, ' | '));
    if (process.env.ALERT_PHONE) {
      try { await whatsappService.sendTextMessage(process.env.ALERT_PHONE, msg); } catch (e) { /* logged above */ }
    }
  }
  const reply = `✅ Your order #${shortId} has been cancelled.` + (kitchen.ok ? ` The kitchen has been told.` : ` We're informing the kitchen now.`);
  await whatsappService.sendTextMessage(from, reply);
  return { handled: true, status: 'cancelled_after_confirm', reply };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Handle an incoming message for a RESTAURANT client. The controller routes
 * here ONLY when businessCategory === 'restaurant', so b2b/dropshipper flows
 * are never reached in this module.
 *
 * @param {Object} params
 * @param {string} params.from - Sender phone
 * @param {Object} params.client - Resolved restaurant client row
 * @param {Object} params.conversation - Current conversations row (or idle default)
 * @param {string} [params.messageType] - 'text' | 'interactive' | 'location'
 * @param {string} [params.text] - Raw text body (text messages)
 * @param {Object|null} [params.buttonReply] - { id, title } for button_reply
 * @param {Object|null} [params.location] - { latitude, longitude, name?, address? }
 * @returns {Promise<{ handled: true, status: string, reply?: string, detail?: string }>}
 */
async function handleRestaurantMessage({ from, client, conversation, messageType, text, buttonReply, location, profileName }) {
  const clientId = client.id;
  conversation = conversation || { state: 'idle', pending_order_data: null };
  let state = conversation.state || 'idle';
  let pending = conversation.pending_order_data || {};
  const trimmedText = String(text || '').trim();

  // A 👍 reaction to one of our messages is not a message — never answer it.
  if (messageType === 'reaction') return { handled: true, status: 'ignored_reaction' };

  // --- Stale-state guard: an abandoned half-finished order expires, so a
  //     customer returning later starts clean instead of being stuck.
  if (state !== 'idle' && conversation.updated_at) {
    const ageMs = Date.now() - new Date(conversation.updated_at).getTime();
    if (Number.isFinite(ageMs) && ageMs > STATE_TTL_MS) {
      console.log(`⏳ rest: state ${state} for ${from} is ${Math.round(ageMs / 60000)} min old — expired, starting fresh.`);
      await db.clearConversationState(from);
      state = 'idle';
      pending = {};
    }
  }

  // WhatsApp's profile name travels with every message; keep it on the held
  // order so the name step (which can run several messages later) can suggest it.
  if (profileName && pending && typeof pending === 'object') pending.profile_name = String(profileName).slice(0, 80);

  // --- Merchant commands (ops contact only) — always allowed, even when the
  //     restaurant is closed (OPEN must work to reopen it).
  if (isRestaurantOpsSender(from, client)) {
    const cmdResult = await processMerchantCommand({ from, client, text: trimmedText });
    if (cmdResult.handled) {
      return { handled: true, status: `merchant_${cmdResult.action}`, reply: cmdResult.reply, detail: 'merchant_command' };
    }
    // Kitchen phones often run WhatsApp Business greeting/away auto-replies,
    // which reply to OUR messages with long text. Answering those with help
    // text risks two bots talking to each other forever, so long non-command
    // text from the ops contact is ignored; short mistyped commands still get help.
    if (trimmedText.length > 50) {
      console.log(`🤫 rest: ignoring long non-command text from ops contact ${from} (likely an auto-reply).`);
      return { handled: true, status: 'merchant_ignored_autoreply', detail: 'merchant_command' };
    }
    // Ops contact text that isn't a command is not a customer order: show help.
    const help = `Ops commands: READY <order-id> · OUT <item> · IN <item> · PRICE <item> <amount> · INFO <text> · CLOSED · OPEN`;
    await whatsappService.sendTextMessage(from, help);
    return { handled: true, status: 'merchant_help', reply: help, detail: 'merchant_command' };
  }

  // --- "Cancel my order" after confirmation (conversation is idle by then).
  //     Allowed even when the restaurant is closed.
  if (state === 'idle' && POST_CANCEL_RE.test(trimmedText)) {
    return handleCancelConfirmedOrder({ from, client });
  }

  // --- "Change name": update the saved name used on future orders.
  if (state === 'idle' && CHANGE_NAME_RE.test(trimmedText)) {
    await db.setConversationState(from, STATE_AWAITING_NAME, { name_only: true, name_candidate: null });
    await whatsappService.sendTextMessage(from, `Sure! What name should I use for your orders? (for example: Amaka)`);
    return { handled: true, status: 'awaiting_new_name' };
  }

  // --- Not accepting orders gate: new orders get a polite decline. Orders
  //     past confirmation are allowed to complete so a live customer isn't
  //     stranded mid-flow by a restaurant closing.
  if (client.accepting_orders === false && !MID_FLOW_STATES.includes(state)) {
    await sendNotAccepting(from);
    return { handled: true, status: 'not_accepting', detail: 'accepting_orders_false' };
  }

  // --- Escape hatch: "cancel" / "start over" always works mid-flow (the
  //     confirm step has its own cancel handling).
  if (state !== 'idle' && state !== STATE_AWAITING_CONFIRM && CANCEL_RE.test(trimmedText)) {
    await db.clearConversationState(from);
    await whatsappService.sendTextMessage(from, `No problem — I've cleared that order. Send me what you'd like whenever you're ready 😊`);
    return { handled: true, status: 'cancelled_midflow' };
  }

  // --- State machine -------------------------------------------------------
  switch (state) {
    case STATE_AWAITING_CONFIRM:
      return handleAwaitingConfirm({ from, client, messageType, trimmedText, buttonReply, pending });

    case STATE_AWAITING_FULFILLMENT:
      return handleAwaitingFulfillment({ from, client, messageType, trimmedText, buttonReply, location, pending });

    case STATE_AWAITING_LOCATION:
      return handleAwaitingLocation({ from, client, messageType, trimmedText, location, pending });

    case STATE_AWAITING_LANDMARK:
      return handleAwaitingLandmark({ from, client, messageType, trimmedText, location, pending });

    case STATE_RESOLVING_ITEMS:
      return handleResolvingItems({ from, client, messageType, trimmedText, buttonReply, pending });

    case STATE_AWAITING_NAME:
      return handleAwaitingName({ from, client, messageType, trimmedText, buttonReply, pending });

    // idle (or unknown state): fresh order.
    default:
      return handleFreshOrder({ from, client, messageType, trimmedText });
  }
}

/**
 * Fresh order (idle): menu-based AI match (matched / ambiguous / no_match per
 * item), merge the matched items into a held order, then EITHER ask the
 * customer to resolve any ambiguous/no_match terms (r_resolving_items — Bug 1
 * + Bug 3) OR, when everything matched, hold for confirmation with buttons.
 */
async function handleFreshOrder({ from, client, messageType, trimmedText }) {
  const clientId = client.id;

  // A bare button/location tap with no text/state is not an order.
  if (messageType === 'interactive' || messageType === 'location') {
    await whatsappService.sendTextMessage(from, `Please send your order as a message (e.g. "2 jollof rice, 1 chicken").`);
    return { handled: true, status: 'prompt_for_order' };
  }

  // No text at all (voice note, photo, sticker, ...): we can't read it.
  if (!trimmedText) {
    const reply = messageType === 'audio'
      ? `🎙️ I can't listen to voice notes yet. Please type your order, e.g. "2 jollof rice, 1 chicken".`
      : `I can only read text messages for now. Please type your order, e.g. "2 jollof rice, 1 chicken".`;
    await whatsappService.sendTextMessage(from, reply);
    return { handled: true, status: 'prompt_for_order_text', reply };
  }

  // A plain greeting gets a welcome + how to order, never an order parse.
  if (GREETING_RE.test(trimmedText)) {
    const reply = `👋 Welcome to ${client.business_name || 'our restaurant'}! Tell me what you'd like to order (e.g. "2 jollof rice, 1 chicken"), or type MENU to see what's available.`;
    await whatsappService.sendTextMessage(from, reply);
    return { handled: true, status: 'welcome', reply };
  }

  const menu = await db.getClientMenu(clientId);

  // An empty menu means the lookup failed (a live restaurant always has one).
  // Say so honestly instead of "we couldn't match that to our menu".
  if (!Array.isArray(menu) || menu.length === 0) {
    const reply = `Sorry, our menu is temporarily unavailable. Please try again in a minute 🙏`;
    await whatsappService.sendTextMessage(from, reply);
    return { handled: true, status: 'menu_unavailable', reply };
  }

  // "Show me the menu" is never an order — answer it before the parser can
  // mistake the phrase for a dish.
  if (isMenuRequest(trimmedText) && await tryAnswerQuestion(from, client, trimmedText, menu)) {
    return { handled: true, status: 'answered_question' };
  }

  let parsed;
  try {
    parsed = await aiService.parseRestaurantMenuOrder(trimmedText, menu);
  } catch (error) {
    console.error(`❌ Restaurant menu-parse error: ${error.message}`);
    await whatsappService.sendTextMessage(from, `Sorry, we couldn't read that order. Please send it again.`);
    return { handled: true, status: 'parse_error' };
  }

  const terms = Array.isArray(parsed.items) ? parsed.items : [];
  if (terms.length === 0) {
    if (await tryAnswerQuestion(from, client, trimmedText, menu)) {
      return { handled: true, status: 'answered_question' };
    }
    await whatsappService.sendTextMessage(from, whatsappService.buildMenuNoMatchMessage(menu));
    return { handled: true, status: 'no_match' };
  }

  const planned = planOrderItems([], terms, menu);

  const pending = {
    client_id: clientId,
    business_name: client.business_name || null,
    ops_contact_phone: client.operations_contact_phone || null,
    items: planned.items,
    total_amount: recomputeTotal(planned.items),
    unresolved: planned.unresolved,
    resolving_index: 0,
    fulfillment: null,
    delivery_location: null,
    location_pin: null
  };

  if (planned.unresolved.length > 0) {
    // Some terms need clarification/alternatives — hold the matched items and
    // ask the first unresolved one (matched items are NOT silently dropped).
    await db.setConversationState(from, STATE_RESOLVING_ITEMS, pending);
    await askForUnresolved(from, client, menu, pending);
    return { handled: true, status: 'resolving_items', detail: `${planned.unresolved.length} unresolved item(s)` };
  }

  await db.setConversationState(from, STATE_AWAITING_CONFIRM, pending);
  await whatsappService.sendConfirmCancelPrompt(from, whatsappService.buildRestaurantConfirmBody(pending));
  return { handled: true, status: 'awaiting_confirm', detail: pending.total_amount.toFixed(2) };
}

/**
 * Ask the customer to resolve the CURRENT unresolved item (pending.unresolved[
 * pending.resolving_index]) with the specific options it should be answered
 * against. Options are persisted on the item so a later text reply resolves
 * against those exact options only (Bug 3 — no guessing, no re-matching the
 * whole menu). When no options exist, the item is dropped with an apology and
 * resolution continues.
 */
async function askForUnresolved(from, client, menu, pending) {
  const index = pending.resolving_index || 0;
  const target = (pending.unresolved || [])[index];
  if (!target) return false;

  const options = await unresolvedOptions(client, menu, target);
  if (options.length === 0) {
    await whatsappService.sendTextMessage(from, `Sorry, we couldn't find "${target.term}" on our menu.`);
    pending.unresolved.splice(index, 1);
    pending.resolving_index = 0;
    pending.total_amount = recomputeTotal(pending.items);
    await db.setConversationState(from, STATE_RESOLVING_ITEMS, pending);
    return askNextOrComplete(from, client, menu, pending);
  }

  target.options = options;
  await db.setConversationState(from, STATE_RESOLVING_ITEMS, pending);
  const body = whatsappService.buildUnresolvedAsk({
    heldItems: pending.items,
    unresolved: { ...target, options }
  });
  await whatsappService.sendResolvePrompt(from, body, options);
  return true;
}

/**
 * After the current unresolved item is handled: ask the next one if any remain,
 * otherwise move the fully-resolved order back to confirmation (full updated
 * summary + Confirm/Cancel buttons — never a silent fresh-order replacement).
 */
async function askNextOrComplete(from, client, menu, pending) {
  const remaining = (pending.unresolved || []).filter(Boolean);
  if (remaining.length) {
    pending.resolving_index = 0;
    await db.setConversationState(from, STATE_RESOLVING_ITEMS, pending);
    await askForUnresolved(from, client, menu, pending);
    return { handled: true, status: 'resolving_items', detail: `${remaining.length} remaining` };
  }

  // Everything resolved by being DROPPED (customer skipped every term): no
  // empty order should ever hit the confirm stage.
  if (!pending.items || pending.items.length === 0) {
    await db.clearConversationState(from);
    const reply = `No items left on your order. Please send it again whenever you're ready.`;
    await whatsappService.sendTextMessage(from, reply);
    return { handled: true, status: 'no_items', reply };
  }

  const confirmPending = {
    client_id: pending.client_id || client.id,
    business_name: pending.business_name || client.business_name || null,
    ops_contact_phone: pending.ops_contact_phone || client.operations_contact_phone || null,
    items: pending.items || [],
    total_amount: pending.total_amount,
    fulfillment: pending.fulfillment || null,
    delivery_location: pending.delivery_location || null,
    location_pin: pending.location_pin || null
  };
  await db.setConversationState(from, STATE_AWAITING_CONFIRM, confirmPending);
  await whatsappService.sendConfirmCancelPrompt(from, whatsappService.buildRestaurantConfirmBody(confirmPending));
  return { handled: true, status: 'resolved_merged', detail: confirmPending.total_amount.toFixed(2) };
}

/**
 * Confirm/Cancel stage: button reply OR plain text ('yes'/'confirm' /
 * 'no'/'cancel' — users type instead of tapping).
 *
 * Free text that is NOT a clean yes/no is handled per Bug 2:
 *   - If it mentions menu terms (a modification / question about a dish), it is
 *     parsed and routed through the SAME no-match/ambiguous resolution used at
 *     fresh order — resolved choices MERGE into the existing pending order —
 *     never blindly re-asked as a bare "YES or NO".
 *   - Otherwise (flat replies like "ok") the customer is re-prompted with the
 *     full order summary re-included, not a content-free YES/NO line.
 */
async function handleAwaitingConfirm({ from, client, messageType, trimmedText, buttonReply, pending }) {
  if (buttonReply && buttonReply.id === 'confirm') return advanceAfterConfirm(from, client, pending);
  if (buttonReply && buttonReply.id === 'cancel') return cancelRestaurantOrder(from, client);

  const intent = classifyConfirmReply(trimmedText);
  if (intent === 'yes') return advanceAfterConfirm(from, client, pending);
  if (intent === 'no') return cancelRestaurantOrder(from, client);

  // A real message at confirm stage that isn't a confirmation: treat mentions
  // of dishes as order modifications and route them through menu-based
  // resolution (Bug 2), so the customer isn't stuck at a bare YES/NO re-ask.
  if (trimmedText) {
    const menu = await db.getClientMenu(client.id);
    if (isMenuRequest(trimmedText) && await tryAnswerQuestion(from, client, trimmedText, menu)) {
      await whatsappService.sendConfirmCancelPrompt(from, whatsappService.buildRestaurantConfirmBody(pending));
      return { handled: true, status: 'answered_question_at_confirm' };
    }
    let parsed;
    try {
      parsed = await aiService.parseRestaurantMenuOrder(trimmedText, menu);
    } catch (error) {
      parsed = { items: [] };
    }

    const terms = Array.isArray(parsed.items) ? parsed.items : [];
    if (terms.length > 0) {
      const planned = planOrderItems(pending.items || [], terms, menu);
      const changed = JSON.stringify(planned.items) !== JSON.stringify(pending.items || []);
      if (changed || planned.unresolved.length > 0) {
        pending.items = planned.items;
        pending.total_amount = recomputeTotal(planned.items);
        pending.unresolved = planned.unresolved;
        pending.resolving_index = 0;
        await db.setConversationState(from, STATE_RESOLVING_ITEMS, pending);
        if (planned.unresolved.length > 0) {
          await askForUnresolved(from, client, menu, pending);
        } else {
          // Clean modification merged outright — re-show the full updated
          // summary with Confirm/Cancel buttons.
          await db.setConversationState(from, STATE_AWAITING_CONFIRM, pending);
          await whatsappService.sendConfirmCancelPrompt(from, whatsappService.buildRestaurantConfirmBody(pending));
        }
        return { handled: true, status: 'modification_resolving' };
      }
    }
  }

  if (trimmedText) {
    const qaMenu = await db.getClientMenu(client.id);
    if (await tryAnswerQuestion(from, client, trimmedText, qaMenu)) {
      // Answered; order stays pending — nudge them back to Confirm/Cancel.
      await whatsappService.sendConfirmCancelPrompt(from, whatsappService.buildRestaurantConfirmBody(pending));
      return { handled: true, status: 'answered_question_at_confirm' };
    }
  }

  const reply = whatsappService.buildConfirmReaskWithContext(pending);
  await whatsappService.sendTextMessage(from, reply);
  return { handled: true, status: 're_prompt_confirm', reply };
}

/**
 * r_resolving_items: handle the customer's answer to the current unresolved
 * item. A button tap or a text reply matching one of the SPECIFIC shown options
 * resolves it; a skip word drops it; any other text is parsed as fresh/modified
 * content whose clean matches MERGE into the held items and whose own
 * ambiguous/no_match terms queue behind the current question. Everything
 * resolves → full updated summary + Confirm/Cancel (never a fresh order).
 */
async function handleResolvingItems({ from, client, messageType, trimmedText, buttonReply, pending }) {
  const clientId = client.id;
  const menu = await db.getClientMenu(clientId);
  const index = pending.resolving_index || 0;
  const current = (pending.unresolved || [])[index] || null;

  let additions = [];
  let removedCurrent = false;

  // 1) Button selection — the specific option shown for the current item.
  if (buttonReply && current) {
    const option = (current.options || []).find(o => String(o.id) === String(buttonReply.id));
    if (option) {
      const product = menu.find(m => m.id === option.id);
      if (product) {
        additions = [canonicalItemFromProduct(product, current.quantity || 1, [])];
        removedCurrent = true;
      }
    }
  }

  // 2) Text reply: resolve current, skip it, or carry fresh content.
  if (!removedCurrent && trimmedText) {
    const lower = trimmedText.toLowerCase();
    if (current && RESOLVE_SKIP_WORDS.some(w => lower.includes(w))) {
      removedCurrent = true;
    } else if (current) {
      const chosen = matchResolutionReply(trimmedText, current.options || []);
      if (chosen === 'ambiguous') {
        // Matched more than one SHOWN option — never guess (Bug 3): re-ask.
        await whatsappService.sendTextMessage(
          from,
          whatsappService.buildResolveReaskMessage({ unresolved: { ...current, options: current.options || [] } })
        );
        return { handled: true, status: 'resolving_reask' };
      } else if (chosen) {
        const product = menu.find(m => m.id === chosen.id);
        if (product) {
          additions = [canonicalItemFromProduct(product, current.quantity || 1, [])];
          removedCurrent = true;
        }
      }
    }

    if (!removedCurrent) {
      // Not a selection of the current item. A menu request is answered
      // first (never queued as a dish), then the pending item is re-asked.
      if (isMenuRequest(trimmedText) && await tryAnswerQuestion(from, client, trimmedText, menu)) {
        return askNextOrComplete(from, client, menu, pending);
      }
      // Otherwise parse as fresh/modified content:
      // merge clean matches, queue new ambiguous/no_match behind the current.
      let parsed;
      try {
        parsed = await aiService.parseRestaurantMenuOrder(trimmedText, menu);
      } catch (error) {
        parsed = { items: [] };
      }
      const terms = Array.isArray(parsed.items) ? parsed.items : [];
      if (terms.length === 0 && await tryAnswerQuestion(from, client, trimmedText, menu)) {
        // Genuine question answered — keep the held order untouched and
        // re-ask the SAME pending item so the customer can carry on.
        return askNextOrComplete(from, client, menu, pending);
      }
      if (terms.length > 0) {
        const before = pending.items || [];
        const after = planOrderItems(before, terms, menu);
        additions = itemsDelta(before, after.items);
        pending.items = after.items;
        // If the customer just re-typed something we were still asking about
        // and it now matches cleanly, drop the stale unresolved entry.
        const matchedTerms = new Set(
          terms.filter(t => t.outcome === 'matched')
            .map(t => String(t.term || '').trim().toLowerCase())
            .filter(Boolean)
        );
        if (matchedTerms.size > 0) {
          pending.unresolved = (pending.unresolved || []).filter(
            u => !matchedTerms.has(String(u.term || '').trim().toLowerCase())
          );
          pending.resolving_index = 0;
        }
        if (after.unresolved.length) {
          pending.unresolved = (pending.unresolved || []).concat(after.unresolved);
        }
      }
    }
  }

  // 3) Apply: merge any choices into the held items; drop the resolved item.
  if (removedCurrent) {
    if (additions.length) {
      pending.items = mergeTermsIntoItems(pending.items || [], additions);
    }
    pending.unresolved = (pending.unresolved || []).filter((_, i) => i !== index);
    pending.resolving_index = 0;
  } else if ((pending.unresolved || []).length === 0) {
    pending.resolving_index = 0;
  }

  pending.total_amount = recomputeTotal(pending.items);
  await db.setConversationState(from, STATE_RESOLVING_ITEMS, pending);

  // Acknowledge merges briefly, then keep asking until everything is resolved.
  if ((pending.unresolved || []).filter(Boolean).length > 0) {
    if (additions.length) {
      await whatsappService.sendTextMessage(from, whatsappService.buildResolveProgressMessage({ addedItems: additions }));
    }
    return askNextOrComplete(from, client, menu, pending);
  }

  if (additions.length) {
    await whatsappService.sendTextMessage(from, whatsappService.buildFreshResolveMessage({ items: pending.items }));
  }
  return askNextOrComplete(from, client, menu, pending);
}

async function cancelRestaurantOrder(from, client) {
  await db.clearConversationState(from);
  const reply = `Order cancelled. Send a new order anytime.`;
  await whatsappService.sendTextMessage(from, reply);
  return { handled: true, status: 'cancelled', reply };
}

/**
 * Confirm accepted: move to the fulfillment choice (delivery/pickup).
 * If the client offers only ONE option, skip the buttons and proceed directly.
 */
async function advanceAfterConfirm(from, client, pending) {
  const offers = chooseFulfillment(client);

  if (offers.length === 0) {
    // Neither option offered — fall back to pickup so the order still completes.
    pending.fulfillment = 'pickup';
    return proceedToNameOrFinalize(from, client, pending);
  }

  if (offers.length === 1) {
    pending.fulfillment = offers[0];
    await db.setConversationState(from, STATE_AWAITING_FULFILLMENT, pending);
    return proceedAfterFulfillmentChoice({ from, client, pending });
  }

  // Both offered: hold and ask with buttons (text fallback also accepted).
  pending.fulfillment = null;
  await db.setConversationState(from, STATE_AWAITING_FULFILLMENT, pending);
  await whatsappService.sendFulfillmentPrompt(
    from,
    `How would you like to receive your order?`,
    { offers_delivery: true, offers_pickup: true }
  );
  return { handled: true, status: 'awaiting_fulfillment' };
}

/**
 * Delivery/Pickup stage: button reply OR text ('delivery'/'pickup'). Then
 * route to location (delivery) or straight to finalize (pickup).
 */
async function handleAwaitingFulfillment({ from, client, messageType, trimmedText, buttonReply, location, pending }) {
  const REPLY_NO_MATCH = `Please reply with "delivery" or "pickup".`;
  let choice = null;

  if (buttonReply && (buttonReply.id === 'delivery' || buttonReply.id === 'pickup')) {
    choice = buttonReply.id;
  } else if (trimmedText) {
    choice = detectFulfillmentChoice(trimmedText);
  }

  if (!choice) {
    // Stale-guard: only re-prompt if this step STILL expects the input right
    // now. If the same customer's conversation already moved past the
    // delivery/pickup step (e.g. their pickup selection was acked and the order
    // is placed / waiting on location), don't tell them to answer it again.
    const moved = await reDispatchIfStateMoved(
      { from, client, messageType, text: trimmedText, buttonReply, location },
      STATE_AWAITING_FULFILLMENT
    );
    if (moved) return moved;

    if (trimmedText) {
      const qaMenu = await db.getClientMenu(client.id);

      // Off-script but clearly a NEW order ("I'd like to order rice"): drop
      // the half-finished one and start over instead of re-asking forever.
      if (!isMenuRequest(trimmedText) && !trimmedText.includes('?')) {
        let freshParse = null;
        try { freshParse = await aiService.parseRestaurantMenuOrder(trimmedText, qaMenu); } catch (e) { freshParse = null; }
        const freshTerms = freshParse && Array.isArray(freshParse.items) ? freshParse.items : [];
        if (freshTerms.some(t => t.outcome === 'matched')) {
          console.log(`♻️ rest: new order text at fulfillment step for ${from} — restarting.`);
          await db.clearConversationState(from);
          return handleFreshOrder({ from, client, messageType, trimmedText });
        }
      }

      // They typed their address instead of tapping "Delivery": that IS the
      // answer — take it as delivery to that address.
      const offeredNow = chooseFulfillment(client);
      if (offeredNow.includes('delivery') && looksLikeAddress(trimmedText)) {
        console.log(`📍 rest: ${from} typed an address at the fulfillment step — treating as DELIVERY.`);
        pending.fulfillment = 'delivery';
        pending.delivery_location = trimmedText;
        return proceedToNameOrFinalize(from, client, pending);
      }

      const answered = await tryAnswerQuestion(from, client, trimmedText, qaMenu);
      const offered = chooseFulfillment(client);
      await whatsappService.sendFulfillmentPrompt(
        from,
        answered
          ? `How would you like to receive your order?`
          : `I'm not sure about that one, but I can get your order moving! How would you like to receive it?`,
        { offers_delivery: offered.includes('delivery'), offers_pickup: offered.includes('pickup') }
      );
      return { handled: true, status: answered ? 'answered_question_at_fulfillment' : 're_prompt_fulfillment' };
    }

    await whatsappService.sendTextMessage(from, REPLY_NO_MATCH);
    return { handled: true, status: 're_prompt_fulfillment', reply: REPLY_NO_MATCH };
  }

  // Guard: the choice must actually be offered (a rogue button id / text).
  const offers = chooseFulfillment(client);
  if (!offers.includes(choice)) {
    const moved = await reDispatchIfStateMoved(
      { from, client, messageType, text: trimmedText, buttonReply, location },
      STATE_AWAITING_FULFILLMENT
    );
    if (moved) return moved;

    await whatsappService.sendTextMessage(from, REPLY_NO_MATCH);
    return { handled: true, status: 're_prompt_fulfillment', reply: REPLY_NO_MATCH };
  }

  console.log(`🛵 ${from} chose ${choice.toUpperCase()} (${messageType}); advancing past ${STATE_AWAITING_FULFILLMENT}.`);
  pending.fulfillment = choice;
  return proceedAfterFulfillmentChoice({ from, client, pending });
}

/**
 * After the fulfillment choice: delivery asks for an address/pin, pickup goes
 * straight to finalize. (Fulfillment+location complete -> kitchen + ETA.)
 */
async function proceedAfterFulfillmentChoice({ from, client, pending }) {
  if (pending.fulfillment === 'delivery') {
    console.log(`🚚 ${from}: delivery selected → state ${STATE_AWAITING_LOCATION}.`);
    await db.setConversationState(from, STATE_AWAITING_LOCATION, pending);
    const reply = `📍 Please send your delivery location — either attach your location pin, or type your address (e.g. "No 12, Awolowo Road, Ikoyi").`;
    await whatsappService.sendLocationRequest(from, reply);
    return { handled: true, status: 'awaiting_location', reply };
  }

  return proceedToNameOrFinalize(from, client, pending);
}

/**
 * Delivery location stage: a shared location pin OR a typed text address is
 * sufficient. If only a pin arrives (no address/name on it), ask once for a
 * landmark or house number before proceeding.
 */
async function handleAwaitingLocation({ from, client, messageType, trimmedText, location, pending }) {
  const REPLY_NO_MATCH = `Please send your address as text or share your location pin.`;

  // A question here ("how long will delivery take?") is NOT an address.
  if (messageType !== 'location' && await answerIfQuestionAtFreeTextStep(
    from, client, trimmedText, `Please send your delivery address as text, or share your location pin 📍`
  )) {
    return { handled: true, status: 'answered_question_at_location' };
  }

  // Typed text address -> sufficient, proceed.
  if (messageType !== 'location' && trimmedText && messageType !== 'interactive') {
    pending.delivery_location = trimmedText;
    return proceedToNameOrFinalize(from, client, pending);
  }

  // Location pin.
  if (messageType === 'location' && location) {
    const hasDescriptive = (location.name && String(location.name).trim()) || (location.address && String(location.address).trim());
    pending.location_pin = {
      latitude: location.latitude || null,
      longitude: location.longitude || null,
      name: location.name || null,
      address: location.address || null
    };
    if (hasDescriptive) {
      pending.delivery_location = [location.name, location.address].filter(Boolean).join(', ');
    } else {
      // Pin only (bare lat/lng) -> ask once for a landmark/house number.
      pending.delivery_location = `Pin: ${location.latitude},${location.longitude}`;
      await db.setConversationState(from, STATE_AWAITING_LANDMARK, pending);
      const reply = `📍 We have your pin! Please add a landmark or house number so the rider can find you easily.`;
      await whatsappService.sendTextMessage(from, reply);
      return { handled: true, status: 'awaiting_landmark', reply };
    }
    return proceedToNameOrFinalize(from, client, pending);
  }

  const moved = await reDispatchIfStateMoved(
    { from, client, messageType, text: trimmedText, buttonReply: null, location },
    STATE_AWAITING_LOCATION
  );
  if (moved) return moved;

  await whatsappService.sendTextMessage(from, REPLY_NO_MATCH);
  return { handled: true, status: 're_prompt_location', reply: REPLY_NO_MATCH };
}

/**
 * Landmark follow-up (after a bare pin): any text is taken as the landmark;
 * a second pin is accepted outright.
 */
async function handleAwaitingLandmark({ from, client, messageType, trimmedText, location, pending }) {
  if (messageType === 'location' && location) {
    pending.delivery_location =
      (location.name || location.address)
        ? [location.name, location.address].filter(Boolean).join(', ')
        : `Pin: ${location.latitude},${location.longitude}`;
    return proceedToNameOrFinalize(from, client, pending);
  }

  if (await answerIfQuestionAtFreeTextStep(
    from, client, trimmedText, `Please send a landmark or house number so the rider can find you.`
  )) {
    return { handled: true, status: 'answered_question_at_landmark' };
  }

  if (trimmedText) {
    pending.delivery_location = pending.delivery_location
      ? `${pending.delivery_location} — ${trimmedText}`
      : trimmedText;
    return proceedToNameOrFinalize(from, client, pending);
  }

  const moved = await reDispatchIfStateMoved(
    { from, client, messageType, text: trimmedText, buttonReply: null, location },
    STATE_AWAITING_LANDMARK
  );
  if (moved) return moved;

  const reply = `Please send a landmark or house number for the delivery.`;
  await whatsappService.sendTextMessage(from, reply);
  return { handled: true, status: 're_prompt_landmark', reply };
}


// ---------------------------------------------------------------------------
// Customer name step
// ---------------------------------------------------------------------------

const CHANGE_NAME_RE = /^\s*(please\s+)?(change|update|edit|correct)\s+(my\s+)?name\s*[.!]*\s*$/i;
const NAME_YES_RE = /^\s*(yes|y|yeah|yep|yup|ok|okay|correct|right|sure|that'?s right|that is right)\s*[.!]*\s*$/i;
const NAME_NO_RE = /^\s*(no|nope|n|change|wrong)\s*[.!]*\s*$/i;
const MAX_NAME_LENGTH = 30;

/**
 * Clean a name for use on a kitchen ticket: keep letters (any alphabet),
 * spaces, apostrophes, dots and hyphens; drop emojis, digits and symbols.
 */
function sanitizeName(raw) {
  let s = String(raw || '').normalize('NFKC');
  s = s.replace(/[^\p{L}\p{M}\s'.\-]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > MAX_NAME_LENGTH) s = s.slice(0, MAX_NAME_LENGTH).trim();
  return s;
}

/** A usable name has at least 2 letters and at most 4 words. */
function isPlausibleName(name) {
  if (!name) return false;
  const letters = (name.match(/\p{L}/gu) || []).length;
  const words = name.split(' ').filter(Boolean).length;
  return letters >= 2 && words <= 4;
}

/**
 * Gate in front of finalize. Returning customers (name saved for this
 * restaurant) skip straight through. New customers are asked once: a tap on
 * "Yes" when their WhatsApp profile name is usable, otherwise a typed name.
 */
async function proceedToNameOrFinalize(from, client, pending) {
  if (pending.customer_name) {
    return finalizeRestaurantOrder(from, client, pending);
  }

  let saved = null;
  try { saved = await db.getCustomerName(client.id, from); } catch (e) { saved = null; }
  if (saved) {
    console.log(`👤 rest: returning customer ${from} → "${saved}" (no name prompt).`);
    pending.customer_name = saved;
    return finalizeRestaurantOrder(from, client, pending);
  }

  const cleaned = sanitizeName(pending.profile_name);
  const candidate = isPlausibleName(cleaned) ? cleaned : null;
  pending.name_candidate = candidate;
  await db.setConversationState(from, STATE_AWAITING_NAME, pending);
  console.log(`👤 rest: asking ${from} for a name (suggestion: ${candidate || 'none'}).`);
  await whatsappService.sendNamePrompt(from, candidate);
  return { handled: true, status: 'awaiting_name' };
}

/**
 * Name step. Accepts the Yes/Change buttons, "yes"/"no" text, or a typed
 * name. In name_only mode ("change name" command) it just saves the name.
 */
async function handleAwaitingName({ from, client, messageType, trimmedText, buttonReply, pending }) {
  const candidate = pending.name_candidate || null;
  const askAgain = async (prefix) => {
    if (candidate) {
      await whatsappService.sendNamePrompt(from, candidate);
    } else {
      await whatsappService.sendTextMessage(from, `${prefix}What name should I put this order under? (for example: Amaka)`);
    }
    return { handled: true, status: 're_prompt_name' };
  };

  // Late/duplicate taps on earlier buttons (a double-tap on Pickup, say).
  if (buttonReply && !['name_yes', 'name_change'].includes(buttonReply.id)) {
    return { handled: true, status: 'ignored_stale_button' };
  }

  let name = null;

  if (buttonReply && buttonReply.id === 'name_yes' && candidate) {
    name = candidate;
  } else if (buttonReply && buttonReply.id === 'name_change') {
    pending.name_candidate = null;
    await db.setConversationState(from, STATE_AWAITING_NAME, pending);
    await whatsappService.sendTextMessage(from, `No problem — what name should I put it under? (for example: Amaka)`);
    return { handled: true, status: 'awaiting_name_typed' };
  } else if (trimmedText) {
    if (candidate && NAME_YES_RE.test(trimmedText)) {
      name = candidate;
    } else if (candidate && NAME_NO_RE.test(trimmedText)) {
      pending.name_candidate = null;
      await db.setConversationState(from, STATE_AWAITING_NAME, pending);
      await whatsappService.sendTextMessage(from, `No problem — what name should I put it under? (for example: Amaka)`);
      return { handled: true, status: 'awaiting_name_typed' };
    } else {
      // A genuine question (not a short name like "Will") is answered, then re-asked.
      const wordCount = trimmedText.split(/\s+/).length;
      if (trimmedText.includes('?') || (wordCount >= 3 && looksLikeQuestion(trimmedText))) {
        const menu = await db.getClientMenu(client.id);
        const answered = await tryAnswerQuestion(from, client, trimmedText, menu);
        await whatsappService.sendTextMessage(
          from,
          (answered ? '' : `I'm not sure about that one. `) +
          (candidate ? `Should I put your order under *${candidate}*? Tap Yes, or type another name.` : `What name should I put this order under?`)
        );
        return { handled: true, status: 'answered_question_at_name' };
      }

      const typed = sanitizeName(trimmedText);
      if (trimmedText.length <= 40 && isPlausibleName(typed)) {
        name = typed;
      } else {
        return askAgain(`That doesn't look like a name. `);
      }
    }
  } else {
    return askAgain('');
  }

  // "change name" command: just save and confirm.
  if (pending.name_only) {
    await db.saveCustomerName(client.id, from, name);
    await db.clearConversationState(from);
    await whatsappService.sendTextMessage(from, `Done ✅ I'll use *${name}* for your orders.`);
    return { handled: true, status: 'name_changed' };
  }

  pending.customer_name = name;
  pending.name_candidate = null;
  console.log(`👤 rest: ${from} → name "${name}".`);
  return finalizeRestaurantOrder(from, client, pending);
}

module.exports = {
  handleRestaurantMessage,
  processMerchantCommand,
  isRestaurantOpsSender,
  chooseFulfillment,
  computeEtaRange,
  BASE_PREP_MINUTES,
  PER_ORDER_MINUTES,
  STATE_AWAITING_CONFIRM,
  STATE_AWAITING_FULFILLMENT,
  STATE_AWAITING_LOCATION,
  STATE_AWAITING_LANDMARK,
  STATE_RESOLVING_ITEMS,
  STATE_AWAITING_NAME,
  sanitizeName,
  isPlausibleName,
  planOrderItems,
  matchResolutionReply,
  consolidateItem
};