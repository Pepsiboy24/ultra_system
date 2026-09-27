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

const MID_FLOW_STATES = [
  STATE_AWAITING_CONFIRM,
  STATE_AWAITING_FULFILLMENT,
  STATE_AWAITING_LOCATION,
  STATE_AWAITING_LANDMARK,
  STATE_RESOLVING_ITEMS
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
  const eta = BASE_PREP_MINUTES + (Number(queueAhead) || 0) * PER_ORDER_MINUTES;
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
      order_type: fulfillment
    });

    await db.createOrderItems(pending.items.map(item => ({
      order_id: order.id,
      product_id: item.product_id,
      quantity: item.quantity,
      unit_price: item.unit_price
    })));

    const queueAhead = await db.countQueueAhead(clientId, order.id);
    const etaRange = computeEtaRange(queueAhead);
    console.log(`🍽️ Order ${order.id} created (${order.order_type}) · queueAhead=${queueAhead} · ETA ${etaRange.string} min`);

    // Kitchen/ops notification (operations_contact_phone, best-effort).
    const opsPhone = client.operations_contact_phone || pending.ops_contact_phone || null;
    if (opsPhone) {
      const ticketResult = await whatsappService.sendTextMessage(
        opsPhone,
        whatsappService.buildRestaurantTicketMessage({
          order,
          items: pending.items,
          total_amount: order.total_amount,
          etaRange: etaRange.string
        })
      );
      console.log(`👨🍳 Kitchen ticket to ${opsPhone}: ${ticketResult && ticketResult.success === true ? 'sent' : `NOT sent (${JSON.stringify(ticketResult)})`}`);
      if (!(ticketResult && ticketResult.success === true)) {
        console.error(`⚠️ Restaurant kitchen ticket to ${opsPhone} NOT sent (continuing):`, JSON.stringify(ticketResult));
      }
    } else {
      console.warn(`⚠️ Restaurant client ${clientId} has no operations_contact_phone — kitchen not notified for order ${order.id}.`);
    }

    // Customer ETA.
    const customerResult = await whatsappService.sendTextMessage(
      customerPhone,
      whatsappService.buildRestaurantEtaMessage({
        order,
        items: pending.items,
        total_amount: order.total_amount,
        etaRange: etaRange.string
      })
    );
    console.log(`📬 Customer ETA to ${customerPhone}: ${customerResult && customerResult.success === true ? 'sent' : `NOT sent (${JSON.stringify(customerResult)})`}`);

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
async function handleRestaurantMessage({ from, client, conversation, messageType, text, buttonReply, location }) {
  const clientId = client.id;
  conversation = conversation || { state: 'idle', pending_order_data: null };
  const state = conversation.state || 'idle';
  const pending = conversation.pending_order_data || {};
  const trimmedText = String(text || '').trim();

  // --- Merchant commands (ops contact only) — always allowed, even when the
  //     restaurant is closed (OPEN must work to reopen it).
  if (isRestaurantOpsSender(from, client)) {
    const cmdResult = await processMerchantCommand({ from, client, text: trimmedText });
    if (cmdResult.handled) {
      return { handled: true, status: `merchant_${cmdResult.action}`, reply: cmdResult.reply, detail: 'merchant_command' };
    }
    // Ops contact text that isn't a command is not a customer order: show help.
    const help = `Ops commands: OUT <item> · IN <item> · CLOSED · OPEN · READY <order-id>`;
    await whatsappService.sendTextMessage(from, help);
    return { handled: true, status: 'merchant_help', reply: help, detail: 'merchant_command' };
  }

  // --- Not accepting orders gate: new orders get a polite decline. Orders
  //     past confirmation are allowed to complete so a live customer isn't
  //     stranded mid-flow by a restaurant closing.
  if (client.accepting_orders === false && !MID_FLOW_STATES.includes(state)) {
    await sendNotAccepting(from);
    return { handled: true, status: 'not_accepting', detail: 'accepting_orders_false' };
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

  const menu = await db.getClientMenu(clientId);

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
      // Not a selection of the current item — parse as fresh/modified content:
      // merge clean matches, queue new ambiguous/no_match behind the current.
      let parsed;
      try {
        parsed = await aiService.parseRestaurantMenuOrder(trimmedText, menu);
      } catch (error) {
        parsed = { items: [] };
      }
      const terms = Array.isArray(parsed.items) ? parsed.items : [];
      if (terms.length > 0) {
        const before = pending.items || [];
        const after = planOrderItems(before, terms, menu);
        additions = itemsDelta(before, after.items);
        pending.items = after.items;
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
    return finalizeRestaurantOrder(from, client, pending);
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

async function cancelRestaurantOrder(from, client) {
  await db.clearConversationState(from);
  const reply = `Order cancelled. Send a new order anytime.`;
  await whatsappService.sendTextMessage(from, reply);
  return { handled: true, status: 'cancelled', reply };
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
    const lower = trimmedText.toLowerCase();
    if (['delivery', 'deliver', 'deliver to'].includes(lower)) choice = 'delivery';
    else if (['pickup', 'pick up', 'pick it up', 'collect'].includes(lower)) choice = 'pickup';
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

  return finalizeRestaurantOrder(from, client, pending);
}

/**
 * Delivery location stage: a shared location pin OR a typed text address is
 * sufficient. If only a pin arrives (no address/name on it), ask once for a
 * landmark or house number before proceeding.
 */
async function handleAwaitingLocation({ from, client, messageType, trimmedText, location, pending }) {
  const REPLY_NO_MATCH = `Please send your address as text or share your location pin.`;

  // Typed text address -> sufficient, proceed.
  if (messageType !== 'location' && trimmedText && messageType !== 'interactive') {
    pending.delivery_location = trimmedText;
    return finalizeRestaurantOrder(from, client, pending);
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
    return finalizeRestaurantOrder(from, client, pending);
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
    return finalizeRestaurantOrder(from, client, pending);
  }

  if (trimmedText) {
    pending.delivery_location = pending.delivery_location
      ? `${pending.delivery_location} — ${trimmedText}`
      : trimmedText;
    return finalizeRestaurantOrder(from, client, pending);
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
  planOrderItems,
  matchResolutionReply,
  consolidateItem
};