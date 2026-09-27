/**
 * WhatsApp Outbound Messaging Service
 *
 * Sends messages back to a user via the WhatsApp Cloud API (Graph API).
 * Uses Node's built-in global fetch (Node 18+).
 */

const GRAPH_API_VERSION = 'v25.0';

/**
 * Send a plain text WhatsApp message.
 * @param {string} to - Recipient phone number in international format, no '+' (e.g. "2347026260030")
 * @param {string} body - Message text to send
 * @returns {Promise<Object>} - Parsed JSON response from the Graph API
 */
async function sendTextMessage(to, body) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    console.error('❌ WhatsApp Send Error: Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN in .env');
    return { success: false, error: 'missing_credentials' };
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ WhatsApp Send Failed:', JSON.stringify(data, null, 2));
      return { success: false, error: data };
    }

    console.log(`📤 WhatsApp Reply Sent to ${to}: "${body.slice(0, 80)}${body.length > 80 ? '...' : ''}"`);
    return { success: true, data };
  } catch (err) {
    console.error('❌ WhatsApp Send Exception:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Format a held order's line items for display, according to its business
 * category so category-specific parsed fields are reflected (not ignored):
 *   - restaurant : "2x Jollof Rice, 1x Chicken (no onions)"   (modifiers inline)
 *   - dropshipper: "10x Red Handbag (color: red)"             (variant inline)
 *   - b2b        : "100kg Tea — delivery: Kaduna, terms: 14-day credit"
 *
 * Fields that are absent from a given order are omitted cleanly — never
 * "undefined" or an empty parenthetical.
 *
 * @param {Object} pendingOrder - { items, delivery_location?, payment_terms? }
 * @param {string} [businessCategory] - 'dropshipper' | 'restaurant' | 'b2b'
 * @returns {string}
 */
function formatPendingItems(pendingOrder, businessCategory) {
  const items = pendingOrder.items || [];
  const nameOf = item => item.product_name || item.item_name;

  switch (businessCategory) {
    case 'restaurant':
      return items
        .map(item => {
          const mods = Array.isArray(item.modifiers) && item.modifiers.length
            ? ` (${item.modifiers.join(', ')})`
            : '';
          return `${item.quantity}x ${nameOf(item)}${mods}`;
        })
        .join('\n');

    case 'dropshipper':
      return items
        .map(item => {
          const variant = item.variant ? ` (color: ${item.variant})` : '';
          return `${item.quantity}x ${nameOf(item)}${variant}`;
        })
        .join('\n');

    case 'b2b': {
      const lines = items.map(item => {
        const base = item.unit
          ? `${item.quantity}${item.unit} ${nameOf(item)}`
          : `${item.quantity}x ${nameOf(item)}`;
        return base;
      });

      const meta = [];
      if (pendingOrder.delivery_location) meta.push(`delivery: ${pendingOrder.delivery_location}`);
      if (pendingOrder.payment_terms) meta.push(`terms: ${pendingOrder.payment_terms}`);

      const summary = lines.join('\n');
      return meta.length ? `${summary} — ${meta.join(', ')}` : summary;
    }

    default:
      return items.map(item => `${item.quantity}x ${nameOf(item)}`).join('\n');
  }
}

/**
 * Build the confirmation prompt for an order held in conversation state.
 * @param {Object} pendingOrder - The pending_order_data stored via setConversationState
 *                                ({ supplier_id, supplier_name, items, total_amount,
 *                                  business_category?, delivery_location?, payment_terms? })
 * @param {string} [businessCategory] - 'dropshipper' | 'restaurant' | 'b2b'.
 *   Falls back to pendingOrder.business_category, then to a generic "N x name" list.
 * @returns {string}
 */
function buildPendingConfirmationMessage(pendingOrder, businessCategory) {
  const category = businessCategory || pendingOrder.business_category;

  return (
    `📋 Please confirm your order:\n\n` +
    `${formatPendingItems(pendingOrder, category)}\n\n` +
    `Total: ₦${Number(pendingOrder.total_amount).toFixed(2)}\n` +
    `Reply YES to confirm or NO to cancel.`
  );
}

/**
 * Build the internal ops ticket sent to a b2b client's operations contact
 * after the customer confirms the order. Asks the ops contact to confirm
 * stock availability before the order is treated as fully approved.
 *
 * @param {Object} params
 * @param {Object} params.order - The created order row ({ id, total_amount })
 * @param {string} params.supplier_name
 * @param {Array} params.items - Validated items (product_name, quantity, unit?)
 * @param {number} params.total_amount
 * @param {string|null} [params.delivery_location]
 * @returns {string}
 */
function buildOpsTicketMessage({ order, supplier_name, items, total_amount, delivery_location }) {
  const itemLines = (items || [])
    .map(item => {
      const name = item.product_name || item.item_name;
      return `• ${item.unit ? `${item.quantity}${item.unit} ${name}` : `${item.quantity}x ${name}`}`;
    })
    .join('\n');

  const lines = [
    `📦 OPS TICKET #${order.id.slice(0, 8).toUpperCase()}`,
    `Order submitted — awaiting stock confirmation.`,
    ``,
    `Supplier: ${supplier_name}`,
    `Items:\n${itemLines}`,
    `Total: ₦${Number(total_amount).toFixed(2)}`
  ];

  if (delivery_location) {
    lines.push(`Delivery: ${delivery_location}`);
  }

  lines.push(`Confirm stock availability for this order.`);
  return lines.join('\n');
}

/**
 * Build the kitchen ticket sent to a restaurant client's kitchen contact after
 * the customer confirms their order. Notification ONLY — no reply handling.
 * Item lines carry modifiers inline, and the ticket states whether the order is
 * dine-in or delivery (order_type), matching the restaurant extraction prompt.
 *
 * @param {Object} params
 * @param {Object} params.order - The created order row ({ id, total_amount })
 * @param {Array} params.items - Validated items (product_name|item_name, quantity, modifiers?)
 * @param {number} params.total_amount
 * @param {string|null} [params.order_type] - 'dine_in' | 'delivery' | null
 * @returns {string}
 */
function buildKitchenTicketMessage({ order, items, total_amount, order_type }) {
  const itemLines = (items || [])
    .map(item => {
      const name = item.product_name || item.item_name;
      const mods = Array.isArray(item.modifiers) && item.modifiers.length
        ? ` (${item.modifiers.join(', ')})`
        : '';
      return `• ${item.quantity}x ${name}${mods}`;
    })
    .join('\n');

  const typeLabel = order_type === 'dine_in'
    ? 'DINE-IN'
    : (order_type === 'delivery' ? 'DELIVERY' : 'Not specified');

  return (
    `👨🍳 KITCHEN TICKET #${String(order.id).slice(0, 8).toUpperCase()} (${order.id})\n` +
    `New order received.\n\n` +
    `Items:\n${itemLines}\n\n` +
    `Type: ${typeLabel}\n` +
    `Total: ₦${Number(total_amount).toFixed(2)}`
  );
}

/**
 * Build the customer-facing message for a restaurant stock-out. Suggests up to
 * 2 in-stock alternatives (same category, else nearest-priced) instead of a
 * flat rejection. With no alternatives, still lands softly.
 *
 * @param {Object} params
 * @param {string} params.failedProductName - The unavailable item.
 * @param {Array} [params.alternatives] - Product rows ({ name, price }).
 * @returns {string}
 */
function buildStockOutMessage({ failedProductName, alternatives }) {
  const alts = Array.isArray(alternatives) ? alternatives.slice(0, 2) : [];

  const lines = [
    `❌ Sorry, "${failedProductName}" is out of stock right now.`
  ];

  if (alts.length > 0) {
    lines.push(
      ``,
      `You might like one of these instead:`,
      ...alts.map(a => `• ${a.name} — ₦${Number(a.price).toFixed(2)}`)
    );
  } else {
    lines.push(``, `Please speak to the restaurant for an alternative.`);
  }

  lines.push(``, `Send a new order anytime.`);
  return lines.join('\n');
}

/**
 * Build a human-readable confirmation/rejection message from a pipeline result.
 * @param {Object} pipelineResult - The result object returned by orderService.processOrderPipeline
 * @returns {string}
 */
function buildOrderReplyMessage(pipelineResult) {
  if (pipelineResult.success) {
    const order = pipelineResult.order;
    const itemLines = (pipelineResult.items || [])
      .map(item => `• ${item.quantity} x ${item.product_name}`)
      .join('\n');

    return (
      `✅ Order confirmed!\n\n` +
      `${itemLines}\n\n` +
      `Total: ₦${Number(order.total_amount).toFixed(2)}\n` +
      `Order ID: ${order.id}\n` +
      (order.invoice_url ? `🧾 Invoice: ${order.invoice_url}\n` : '') +
      (order.payment_link ? `Pay here: ${order.payment_link}` : '')
    );
  }

  // Explicit customer-facing copy (set on recovery paths, e.g. an audit-trail
  // insert failure that must never show the customer a raw exception).
  if (pipelineResult.customer_message) {
    return pipelineResult.customer_message;
  }

  return `❌ Sorry, we couldn't process your order.\n\nReason: ${pipelineResult.reason || 'Unknown error.'}`;
}

/**
 * Build the WhatsApp payment-confirmation message sent to the customer after
 * the payment provider confirms (webhook) that their order was paid.
 *
 * @param {Object} params
 * @param {string} params.orderId - The order id (e.g. ord-abc123)
 * @param {number|string} params.total_amount - Amount paid, in naira
 * @param {string} [params.paymentMethod] - e.g. 'ACCOUNT_TRANSFER' | 'CARD'
 * @returns {string}
 */
function buildPaymentConfirmationMessage({ orderId, total_amount, paymentMethod }) {
  return (
    `💳 Payment received!\n\n` +
    `Order #${String(orderId).slice(0, 8).toUpperCase()}\n` +
    `Amount paid: ₦${Number(total_amount).toFixed(2)}\n` +
    `Method: ${paymentMethod ? paymentMethod.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : 'Card / Transfer'}\n\n` +
    `Thank you — your order is confirmed.`
  );
}

/**
 * Build the WhatsApp confirmation request sent to a SUPPLIER after a
 * dropshipper-category customer confirms their order. Mirrors the B2B ops
 * ticket pattern (buildOpsTicketMessage) but asks the supplier to accept or
 * decline fulfillment, and always carries the order reference so the reply
 * side can (re)anchor on it.
 *
 * @param {Object} params
 * @param {Object} params.order - The created order row ({ id, total_amount })
 * @param {string} params.supplier_name
 * @param {Array} params.items - Validated items (product_name, quantity, unit?)
 * @param {number} params.total_amount
 * @param {string|null} [params.delivery_location]
 * @returns {string}
 */
function buildSupplierRequestMessage({ order, supplier_name, items, total_amount, delivery_location }) {
  const itemLines = (items || [])
    .map(item => {
      const name = item.product_name || item.item_name;
      return `• ${item.unit ? `${item.quantity}${item.unit} ${name}` : `${item.quantity}x ${name}`}`;
    })
    .join('\n');

  const lines = [
    `📦 SUPPLIER ORDER #${String(order.id).slice(0, 8).toUpperCase()} (${order.id})`,
    `A customer has ordered from you.`,
    ``,
    `Supplier: ${supplier_name}`,
    `Items:\n${itemLines}`,
    `Total: ₦${Number(total_amount).toFixed(2)}`
  ];

  if (delivery_location) {
    lines.push(`Delivery: ${delivery_location}`);
  }

  lines.push(`Reply YES to confirm fulfillment or NO to decline.`);
  return lines.join('\n');
}

/**
 * Build the WhatsApp note sent to the SELLER (the client's own business line)
 * once an order is supplier-confirmed: order reference + how to mark it ready.
 *
 * @param {Object} params
 * @param {Object} params.order - The confirmed order row ({ id, total_amount })
 * @param {string} params.supplier_name
 * @param {number|string} params.total_amount
 * @returns {string}
 */
function buildSellerReadyPrompt({ order, supplier_name, total_amount }) {
  const shortId = String(order.id).slice(0, 8).toUpperCase();
  return (
    `📦 Order #${shortId} (${order.id})\n` +
    `Supplier: ${supplier_name}\n` +
    `Total: ₦${Number(total_amount).toFixed(2)}\n\n` +
    `Supplier confirmed this order. Reply PROGRESS ${shortId} once it starts being prepared, ` +
    `or READY ${shortId} when it's ready for the customer.`
  );
}

/**
 * Build the WhatsApp message to the CUSTOMER when the seller marks the order
 * ready (ready_for_customer): full order + payment link.
 *
 * @param {Object} params
 * @param {string} params.orderId - The order id (e.g. ord-abc123)
 * @param {number|string} params.total_amount
 * @param {string} [params.payment_link]
 * @returns {string}
 */
function buildOrderReadyMessage({ orderId, total_amount, payment_link }) {
  return (
    `🎉 Your order is ready!\n\n` +
    `Order #${String(orderId).slice(0, 8).toUpperCase()}\n` +
    `Total: ₦${Number(total_amount).toFixed(2)}\n` +
    (payment_link ? `Pay here: ${payment_link}` : '')
  );
}

/**
 * Build the WhatsApp milestone message to the CUSTOMER when the seller marks
 * the order 'in_progress' (PROGRESS command): preparation has started.
 *
 * @param {Object} params
 * @param {string} params.orderId - The order id (e.g. ord-abc123)
 * @returns {string}
 */
function buildOrderProgressMessage({ orderId }) {
  return (
    `🍳 Your order is being prepared!\n\n` +
    `Order #${String(orderId).slice(0, 8).toUpperCase()}\n` +
    `We'll let you know when it's ready.`
  );
}

/**
 * Send a WhatsApp interactive reply-button message (Confirm/Cancel,
 * Delivery/Pickup, etc.). Uses the same Graph API call pattern as
 * sendTextMessage. At most 3 buttons, each title <= 20 chars.
 *
 * @param {string} to - Recipient phone (no '+')
 * @param {string} body - Interactive message body text
 * @param {Array<{ id: string, title: string }>} buttons - Reply buttons
 * @param {string} [footer] - Optional footer text
 * @returns {Promise<Object>} Same shape as sendTextMessage
 */
async function sendInteractiveButtons(to, body, buttons, footer) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    console.error('❌ WhatsApp Send Error: Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN in .env');
    return { success: false, error: 'missing_credentials' };
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: {
        buttons: (buttons || []).map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.title }
        }))
      }
    }
  };
  if (footer) {
    payload.interactive.footer = { text: footer };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ WhatsApp Interactive Send Failed:', JSON.stringify(data, null, 2));
      return { success: false, error: data };
    }

    console.log(`📤 WhatsApp Interactive Sent to ${to}: "${body.slice(0, 80)}${body.length > 80 ? '...' : ''}"`);
    return { success: true, data };
  } catch (err) {
    console.error('❌ WhatsApp Interactive Send Exception:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send the Confirm/Cancel button prompt for a held restaurant order.
 * @param {string} to
 * @param {string} body - Order summary (buildRestaurantConfirmBody)
 * @returns {Promise<Object>}
 */
async function sendConfirmCancelPrompt(to, body) {
  return sendInteractiveButtons(
    to,
    body,
    [
      { id: 'confirm', title: 'Confirm' },
      { id: 'cancel', title: 'Cancel' }
    ],
    'Tap Confirm or Cancel.'
  );
}

/**
 * Send the Delivery/Pickup prompt for a restaurant order. The button set only
 * includes the options the client offers (offers_delivery / offers_pickup).
 * When exactly one option is offered the caller should skip this and proceed
 * directly — see restaurantService.chooseFulfillment.
 *
 * @param {string} to
 * @param {string} body
 * @param {{ offers_delivery: boolean, offers_pickup: boolean }} options
 * @returns {Promise<Object>}
 */
async function sendFulfillmentPrompt(to, body, { offers_delivery, offers_pickup }) {
  const buttons = [];
  if (offers_delivery) buttons.push({ id: 'delivery', title: 'Delivery' });
  if (offers_pickup) buttons.push({ id: 'pickup', title: 'Pickup' });
  if (buttons.length === 0) return { success: false, error: 'no_fulfillment_options' };
  return sendInteractiveButtons(to, body, buttons, 'How would you like to receive your order?');
}

/**
 * Send a location request to a restaurant customer. The WhatsApp Cloud API has
 * no built-in "request location" message type (only location SHARING), so this
 * is a plain text prompt that accepts both a shared location pin and a typed
 * text address — see restaurantService.
 * @param {string} to
 * @param {string} body
 * @returns {Promise<Object>}
 */
async function sendLocationRequest(to, body) {
  return sendTextMessage(to, body);
}

/**
 * Format a restaurant order's items for display (quantity x name + modifiers).
 * @param {Array<Object>} items - [{ product_name, quantity, modifiers? }]
 * @returns {string}
 */
function formatRestaurantItems(items) {
  return (items || [])
    .map(item => {
      const name = item.product_name || item.item_name;
      const mods = Array.isArray(item.modifiers) && item.modifiers.length
        ? ` (${item.modifiers.join(', ')})`
        : '';
      return `${item.quantity}x ${name}${mods}`;
    })
    .join('\n');
}

/**
 * Build the confirmation prompt body for a held restaurant order
 * (customer-facing, sent alongside the Confirm/Cancel buttons).
 * @param {Object} pending - { items, total_amount }
 * @returns {string}
 */
function buildRestaurantConfirmBody(pending) {
  return (
    `📋 Please confirm your order:\n\n` +
    `${formatRestaurantItems(pending.items)}\n\n` +
    `Total: ₦${Number(pending.total_amount).toFixed(2)}`
  );
}

/**
 * Build the kitchen/ops notification sent to a restaurant client's
 * operations_contact_phone after the customer completes the order (fulfillment
 * + location). Notification only — the ops contact answers with the READY
 * <short> command once the order is ready.
 *
 * @param {Object} params
 * @param {Object} params.order - Created order row ({ id, total_amount, order_type, delivery_location })
 * @param {Array<Object>} params.items - Validated items
 * @param {number} params.total_amount
 * @param {string} params.etaRange - e.g. '20-25' minutes
 * @returns {string}
 */
function buildRestaurantTicketMessage({ order, items, total_amount, etaRange }) {
  const shortId = String(order.id).slice(0, 8).toUpperCase();
  const typeLabel = order.order_type === 'pickup' ? 'PICKUP' : 'DELIVERY';
  const lines = [
    `👨🍳 NEW ORDER #${shortId} (${order.id})`,
    `Please prepare the following:\n\n${formatRestaurantItems(items)}`,
    `Total: ₦${Number(total_amount).toFixed(2)}`,
    `Type: ${typeLabel}`
  ];
  if (order.order_type === 'delivery' && order.delivery_location) {
    lines.push(`Delivery: ${order.delivery_location}`);
  }
  lines.push(`ETA: about ${etaRange} minutes`);
  lines.push(`Reply READY ${shortId} once it's ready.`);
  return lines.join('\n');
}

/**
 * Build the customer-facing ETA message after their restaurant order is
 * confirmed (fulfillment + location complete). Payment deliberately absent —
 * the restaurant payment model is undecided (see restaurant-flow TODO).
 *
 * @param {Object} params
 * @param {Object} params.order - Created order row
 * @param {Array<Object>} params.items
 * @param {number} params.total_amount
 * @param {string} params.etaRange - e.g. '20-25' minutes
 * @returns {string}
 */
function buildRestaurantEtaMessage({ order, items, total_amount, etaRange }) {
  const shortId = String(order.id).slice(0, 8).toUpperCase();
  return (
    `✅ Order confirmed! (Order #${shortId})\n\n` +
    `${formatRestaurantItems(items)}\n\n` +
    `Total: ₦${Number(total_amount).toFixed(2)}\n` +
    `🕐 Ready in about ${etaRange} minutes.\n` +
    (order.order_type === 'delivery'
      ? `🛵 Your order is on the way to you.\n`
      : `🏃 We'll let you know when it's ready for pickup.`)
  );
}

/**
 * Build the customer-facing message when the merchant marks a restaurant order
 * ready (READY <short>): "ready for pickup" vs "out for delivery".
 *
 * @param {Object} params
 * @param {string} params.orderId
 * @param {string} params.orderType - 'delivery' | 'pickup'
 * @returns {string}
 */
function buildRestaurantReadyMessage({ orderId, orderType }) {
  const shortId = String(orderId).slice(0, 8).toUpperCase();
  return orderType === 'delivery'
    ? `🛵 Your order #${shortId} is out for delivery! Enjoy.`
    : `🎉 Your order #${shortId} is ready for pickup! Come and get it.`;
}

/**
 * Shorten a restaurant menu name for use as an interactive button title
 * (WhatsApp caps button titles at 20 characters). Breaks at a word boundary
 * and appends an ellipsis when truncation is needed.
 * @param {string} name
 * @returns {string}
 */
function shortRestaurantButtonTitle(name) {
  const s = String(name || '').trim();
  if (s.length <= 20) return s;
  const cut = s.slice(0, 21).replace(/\s+\S*$/, '').replace(/[+\-_,.&\s]+$/, '').trim();
  if (!cut) return `${s.slice(0, 19)}…`;
  return `${cut}…`;
}

/**
 * Send the resolution prompt for a restaurant item the customer needs to
 * disambiguate (ambiguous term) or choose an alternative for (no_match). The
 * button set is exactly the specific options the upstream want answered, each
 * id being a real product id (which whatsappController extracts back as
 * buttonReply), so the follow-up can resolve against those options only.
 * WhatsApp allows at most 3 buttons, so options are capped at 3 upstream.
 *
 * @param {string} to
 * @param {string} body - Build via buildUnresolvedAsk
 * @param {Array<{ id: string, name: string, price: number }>} options
 * @returns {Promise<Object>}
 */
async function sendResolvePrompt(to, body, options) {
  const buttons = (options || []).slice(0, 3).map(o => ({
    id: String(o.id),
    title: shortRestaurantButtonTitle(o.name)
  }));
  if (buttons.length === 0) return { success: false, error: 'no_resolve_options' };
  return sendInteractiveButtons(to, body, buttons, 'Tap to choose, or type your answer.');
}

/**
 * Build the customer-facing body for a menu-item resolution question. Used
 * when an ordered term is either ambiguous (several menu items match) or has
 * no exact menu match (the shop suggests alternatives). Includes what is held
 * so far (matched items that will merge once resolution completes) so the
 * customer always sees the running order — resolution never silently resets it.
 *
 * @param {Object} params
 * @param {Array<Object>} params.heldItems - Items already resolved/held
 * @param {Object} params.unresolved - { kind:'ambiguous'|'no_match', term,
 *   quantity, options:[{ id, name, price }] }
 * @returns {string}
 */
function buildUnresolvedAsk({ heldItems, unresolved }) {
  const heldHeader = Array.isArray(heldItems) && heldItems.length
    ? `📝 Here's what we have so far:\n${formatRestaurantItems(heldItems)}\n\n`
    : '';
  const options = (unresolved.options || [])
    .map((o, i) => `${i + 1}. ${o.name} — ₦${Number(o.price).toFixed(2)}`)
    .join('\n');
  const guidance = `\n\nTip: tap an option below, or type the dish you'd like.`;
  if (unresolved.kind === 'no_match') {
    return `${heldHeader}❌ We couldn't find "${unresolved.term}" on our menu. Did you mean one of these?\n\n${options}${guidance}`;
  }
  return `${heldHeader}🤔 "${unresolved.term}" could be a few different dishes. Which one did you mean?\n\n${options}${guidance}`;
}

/**
 * Short acknowledgement that items were added to the held order mid-resolution
 * (before the next unresolved question is asked). The FULL re-shown summary
 * comes once everything resolves (Confirm/Cancel prompt).
 *
 * @param {Object} params
 * @param {Array<Object>} params.addedItems - Items merged this round
 * @returns {string}
 */
function buildResolveProgressMessage({ addedItems }) {
  return `✅ Got it! Added to your order:\n${formatRestaurantItems(addedItems)}`;
}

/**
 * Acknowledge a resolution reply that was itself a fresh list of items that
 * merged into the held order (never a fresh order replacement). Full summary
 * with Confirm/Cancel follows once no other terms are still pending.
 *
 * @param {Object} params
 * @param {Array<Object>} params.items - Updated merged items
 * @returns {string}
 */
function buildFreshResolveMessage({ items }) {
  return `📝 OK — here's your updated order:\n${formatRestaurantItems(items)}`;
}

/**
 * Re-ask the resolution question for the current unresolved item, used when a
 * text reply matched none of the specific shown options (or matched several —
 * the shop never silently guesses, so the customer is asked again).
 *
 * @param {Object} params
 * @param {Object} params.unresolved - { kind, term, options }
 * @returns {string}
 */
function buildResolveReaskMessage({ unresolved }) {
  const options = (unresolved.options || [])
    .map((o, i) => `${i + 1}. ${o.name}`)
    .join('\n');
  return `Sorry, I didn't catch that. Please pick one of:\n\n${options}`;
}

/**
 * Re-prompt confirm/cancel for a held restaurant order, RE-INCLUDING the full
 * order summary. Used by the text fallback in the confirm stage (customers who
 * type instead of tapping): the summary must be in front of them again, never
 * a bare "YES or NO" line.
 *
 * @param {Object} pending - { items, total_amount }
 * @returns {string}
 */
function buildConfirmReaskWithContext(pending) {
  return (
    `📋 Here's your order again:\n\n` +
    `${formatRestaurantItems(pending.items)}\n\n` +
    `Total: ₦${Number(pending.total_amount).toFixed(2)}\n\n` +
    `Reply YES to confirm or NO to cancel.`
  );
}

/**
 * Polite "not currently accepting orders" reply (accepting_orders = false).
 * @returns {string}
 */
function buildNotAcceptingOrdersMessage() {
  return `🙏 Thanks for reaching out! We're not currently accepting orders, but please try again soon.`;
}

/**
 * Reply when a restaurant customer's message can't be matched to any menu
 * item. Shows a few available examples to steer them back on menu.
 *
 * @param {Array<Object>} menu - Client menu products
 * @returns {string}
 */
function buildMenuNoMatchMessage(menu) {
  const examples = (menu || [])
    .filter(m => m.is_available !== false)
    .slice(0, 4)
    .map(m => `• ${m.name} — ₦${Number(m.price).toFixed(2)}`)
    .join('\n');
  const suffix = examples ? `\n\nSome of our dishes:\n${examples}` : '';
  return `❌ Sorry, we couldn't match that to our menu. Please order something from it.${suffix}`;
}

module.exports = {
  sendTextMessage,
  sendInteractiveButtons,
  sendConfirmCancelPrompt,
  sendFulfillmentPrompt,
  sendLocationRequest,
  sendResolvePrompt,
  buildUnresolvedAsk,
  buildResolveProgressMessage,
  buildFreshResolveMessage,
  buildResolveReaskMessage,
  buildConfirmReaskWithContext,
  buildPendingConfirmationMessage,
  buildOrderReplyMessage,
  buildOpsTicketMessage,
  buildKitchenTicketMessage,
  buildStockOutMessage,
  buildSupplierRequestMessage,
  buildSellerReadyPrompt,
  buildOrderReadyMessage,
  buildOrderProgressMessage,
  buildPaymentConfirmationMessage,
  formatRestaurantItems,
  buildRestaurantConfirmBody,
  buildRestaurantTicketMessage,
  buildRestaurantEtaMessage,
  buildRestaurantReadyMessage,
  buildNotAcceptingOrdersMessage,
  buildMenuNoMatchMessage
};
