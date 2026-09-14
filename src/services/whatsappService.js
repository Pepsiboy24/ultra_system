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

module.exports = {
  sendTextMessage,
  buildPendingConfirmationMessage,
  buildOrderReplyMessage,
  buildOpsTicketMessage,
  buildKitchenTicketMessage,
  buildStockOutMessage,
  buildSupplierRequestMessage,
  buildSellerReadyPrompt,
  buildOrderReadyMessage,
  buildOrderProgressMessage,
  buildPaymentConfirmationMessage
};
