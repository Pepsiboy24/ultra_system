/**
 * Order Service
 * 
 * Manages the B2B order pipeline validation rules:
 * 1. Matches supplier and products
 * 2. Checks inventory levels
 * 3. Validates supplier credit availability
 * 4. Executes transaction updates (balance & stock)
 * 5. Generates payment links and order records
 * 6. Holds fully validated (but unconfirmed) orders in conversation state so
 *    the customer can confirm before the success path creates any order row.
 */

const db = require('../config/db');
const whatsappService = require('./whatsappService');
const paymentService = require('./paymentService');

// How long an unconfirmed pending order remains valid. After this window, a
// next incoming message is treated as a brand-new order instead of a YES/NO
// reply (see isConfirmationExpired).
const CONFIRMATION_TIMEOUT_MINUTES = 30;

/**
 * True when an 'awaiting_confirmation' conversation is stale and should no
 * longer block a new order. Checks the age of the row's updated_at.
 * Missing/invalid updated_at is NOT treated as expired — setConversationState
 * always writes updated_at, so this only affects malformed legacy rows.
 *
 * @param {string|null|undefined} updatedAt - ISO timestamp from the conversations row
 * @returns {boolean}
 */
function isConfirmationExpired(updatedAt) {
  if (!updatedAt) return false;
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  if (Number.isNaN(ageMs)) return false;
  return ageMs > CONFIRMATION_TIMEOUT_MINUTES * 60 * 1000;
}

/**
 * Log the warning and create a 'rejected' order row. Every rejection path uses
 * this so there is always an audit trail in the orders table.
 */
async function createRejectedOrder(supplierId, reason, totalAmount = 0.00, clientId = null) {
  console.warn(`⚠️ Pipeline Rejected: ${reason}`);
  return db.createOrder({
    client_id: clientId,
    supplier_id: supplierId,
    status: 'rejected',
    status_reason: reason,
    total_amount: totalAmount,
    payment_status: 'pending'
  });
}

/**
 * Shared validation: matches each item to a product, checks stock, then checks
 * the supplier's credit. Both the first-parse (idle) path and the confirm path
 * run the EXACT same checks — fuzzy product matching etc. is unchanged.
 *
 * `businessCategory` is only used to augment an 'insufficient_stock' failure
 * for RESTAURANT orders: up to 2 in-stock alternatives (same category, else
 * nearest-priced) are attached so the rejection can suggest them instead of a
 * flat "out of stock".
 * @returns {Promise<{ ok: true, validatedItems: Array, totalOrderAmount: number }
 *                    | { ok: false, reason: string, kind: string,
 *                        failedProductName?: string, totalOrderAmount?: number,
 *                        alternatives?: Array<Object> }>}
 */
async function validateItemsAndCredit(supplier, items, clientId = null, businessCategory = null) {
  if (!items || items.length === 0) {
    return { ok: false, reason: 'No products detected in order message.', kind: 'no_items' };
  }

  const validatedItems = [];
  let totalOrderAmount = 0;

  for (const item of items) {
    const product = await db.getProductByName(item.product_name, clientId);

    // Product does not exist
    if (!product) {
      return {
        ok: false,
        kind: 'product_not_found',
        failedProductName: item.product_name,
        reason: `Product "${item.product_name}" not found.`
      };
    }

// Insufficient stock
    if (item.quantity > product.stock_quantity) {
      const failure = {
        ok: false,
        kind: 'insufficient_stock',
        failedProductName: product.name,
        totalOrderAmount,
        reason: `Insufficient stock for "${product.name}" (requested: ${item.quantity}, available: ${product.stock_quantity}).`
      };
      // Restaurant orders: suggest same-category (else nearest-priced) in-stock
      // alternatives so the customer sees options instead of a flat rejection.
      if (businessCategory === 'restaurant') {
        failure.alternatives = await db.getInStockAlternatives({
          clientId,
          excludeName: product.name,
          category: product.category || null,
          referencePrice: Number(product.price)
        });
      }
      return failure;
    }

    const itemTotal = parseFloat((product.price * item.quantity).toFixed(2));
    totalOrderAmount += itemTotal;

    validatedItems.push({
      product_id: product.id,
      product_name: product.name,
      quantity: item.quantity,
      unit_price: product.price,
      item_total: itemTotal,
      // Carry category-specific parsed fields through so the confirmation
      // message can reflect them (variant for dropshipper, modifiers for
      // restaurant, unit for b2b). Core validation stays category-agnostic —
      // these extras are not used by any check or DB insert here.
      ...(item.variant ? { variant: item.variant } : {}),
      ...(Array.isArray(item.modifiers) && item.modifiers.length ? { modifiers: item.modifiers } : {}),
      ...(item.unit ? { unit: item.unit } : {})
    });
  }

  totalOrderAmount = parseFloat(totalOrderAmount.toFixed(2));

  // --- Supplier Credit Check ---
  const availableCredit = parseFloat((supplier.credit_limit - supplier.outstanding_balance).toFixed(2));
  if (totalOrderAmount > availableCredit) {
    return {
      ok: false,
      kind: 'credit_exceeded',
      totalOrderAmount,
      reason: `Credit limit exceeded. Order total: ₦${totalOrderAmount.toFixed(2)}, Available credit: ₦${availableCredit.toFixed(2)}.`
    };
  }

  return { ok: true, validatedItems, totalOrderAmount };
}

/**
 * Create the order + order items, set the payment link, and apply the
 * stock/balance updates. (Original pipeline steps 4a-4d, unchanged.)
 *
 * B2B ops routing: when an `opsContactPhone` is provided (a b2b client with
 * an operations contact configured), the order is created as
 * 'pending_ops_confirmation' instead of 'approved' and an internal ops
 * ticket is sent to that number for stock confirmation.
 *
 * Dropshipper routing: for business_category 'dropshipper' with a supplier
 * that has a contact_phone, the order is created as
 * 'pending_supplier_confirmation' and a YES/NO request goes to the supplier.
 * A dropshipper order whose supplier has no WhatsApp number falls back to
 * 'approved' (there is no one to ask) — downstream that is treated exactly
 * like the dropshipper 'supplier_confirmed' state (reminder eligibility,
 * invoice badges, payment flow).
 *
 * Restaurant routing: for business_category 'restaurant' with a client
 * kitchen_contact_phone, a formatted kitchen ticket (item, quantity,
 * modifiers, dine-in/delivery) is sent to the kitchen line after the customer
 * confirms. Notification only — no reply handling, no state change.
 *
 * Tickets are best-effort — a send failure never fails an otherwise valid
 * order; the order simply stays in its awaiting state.
 *
 * @param {string|null} [opsContactPhone]
 * @param {{ delivery_location?: string|null, client_id?: string|null,
 *           business_category?: string|null, business_name?: string|null,
 *           kitchen_contact_phone?: string|null, order_type?: string|null,
 *           customer_phone?: string|null }} [orderMeta]
 * @returns {Promise<{ success: true, order: Object, items: Array<Object>, ticket_sent: boolean }>}
 */
async function createApprovedOrder(supplier, validatedItems, totalOrderAmount, opsContactPhone = null, orderMeta = {}) {
  const isDropshipper = orderMeta.business_category === 'dropshipper';
  const isRestaurant = orderMeta.business_category === 'restaurant';
  const supplierPhone = isDropshipper && supplier.contact_phone ? supplier.contact_phone : null;
  const kitchenPhone = isRestaurant && orderMeta.kitchen_contact_phone ? orderMeta.kitchen_contact_phone : null;
  // Dropshipper supplier confirmation takes precedence over b2b ops routing.
  const needsSupplierConfirmation = !!supplierPhone;
  const needsOpsConfirmation = !needsSupplierConfirmation && !!opsContactPhone;
  const orderStatus = needsSupplierConfirmation
    ? 'pending_supplier_confirmation'
    : (needsOpsConfirmation ? 'pending_ops_confirmation' : 'approved');
  const statusReason = needsSupplierConfirmation
    ? 'Customer confirmed; awaiting supplier fulfillment confirmation.'
    : (needsOpsConfirmation
        ? 'Customer confirmed; awaiting operations stock confirmation.'
        : 'All checks passed successfully.');

  const clientId = orderMeta.client_id || null;
  console.log(`✅ Order ${orderStatus}! Total amount: ₦${totalOrderAmount.toFixed(2)}. Applying updates...`);

  // 4a. Create the order first to get an ID
  const order = await db.createOrder({
    client_id: clientId,
    supplier_id: supplier.id,
    status: orderStatus,
    status_reason: statusReason,
    total_amount: totalOrderAmount,
    payment_status: 'pending',
    business_name: orderMeta.business_name || null,
    delivery_location: orderMeta.delivery_location || null,
    payment_terms: orderMeta.payment_terms || null,
    customer_phone: orderMeta.customer_phone || null
  });

  // 4b. Generate a REAL payment link for the customer: a Monnify hosted
  //      checkout routed 100% to THIS client's own sub-account (per client_id),
  //      then persist it + the Monnify transaction reference on the order.
  //      In dev/mock (no MONNIFY_* creds) the monnify client simulates the
  //      checkout; if the client has no settlement profile the order still
  //      completes with a placeholder link so nothing dead-ends.
  const payment = await paymentService.createCheckoutForOrder({
    order,
    clientId,
    amount: totalOrderAmount,
    customerName: orderMeta.business_name || (supplier && supplier.name) || 'Customer',
    customerEmail: null,
    paymentDescription: `Tea order ${order.id} (${supplier.name})`
  });

  if (payment && payment.checkoutUrl) {
    order.payment_link = payment.checkoutUrl;
    await db.updateOrderPaymentLink(order.id, payment.checkoutUrl, clientId);
    if (payment.transactionReference) {
      order.payment_transaction_reference = payment.transactionReference;
      await db.updateOrderTransactionReference(order.id, payment.transactionReference, clientId);
    }
  } else {
    console.warn(`⚠️ No Monnify payment link for order ${order.id} (client "${clientId || 'default'}" has no sub-account). Falling back to placeholder link.`);
    const placeHolderLink = `https://checkout.teapipeline.com/pay/${order.id}`;
    order.payment_link = placeHolderLink;
    await db.updateOrderPaymentLink(order.id, placeHolderLink, clientId);
  }

  // 4b.2 Generate the hosted invoice URL and persist it. The invoice page is
  //      served by this app at GET /api/invoices/:orderId; APP_BASE_URL is the
  //      externally-reachable base (defaults to localhost for local runs).
  const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const invoiceUrl = `${appBaseUrl}/api/invoices/${order.id}`;
  order.invoice_url = invoiceUrl;
  await db.updateOrderInvoiceUrl(order.id, invoiceUrl, clientId);

  // 4c. Create Order Items
  const orderItemsData = validatedItems.map(item => ({
    order_id: order.id,
    product_id: item.product_id,
    quantity: item.quantity,
    unit_price: item.unit_price
  }));
  const createdItems = await db.createOrderItems(orderItemsData);

  // 4d. Transaction Update: stock levels and supplier balance
  await db.updateStockAndBalance({
    items: validatedItems,
    supplier_id: supplier.id,
    balance_adjustment: totalOrderAmount
  }, clientId);

  console.log(`🎉 Pipeline Completed: Order ${order.id} processed successfully.`);

  // --- Awaiting confirmation notifications: forward to whoever must approve
  //     the order before it is treated as fully confirmed. Dropshipper orders
  //     go to the matched supplier; b2b orders go to the client's ops contact.
  let ticketSent = false;
  if (needsSupplierConfirmation) {
    const request = whatsappService.buildSupplierRequestMessage({
      order,
      supplier_name: supplier.name,
      items: validatedItems,
      total_amount: totalOrderAmount,
      delivery_location: orderMeta.delivery_location || null
    });
    const sendResult = await whatsappService.sendTextMessage(supplierPhone, request);
    ticketSent = !!(sendResult && sendResult.success === true);
    if (!ticketSent) {
      console.error(`⚠️ Supplier request to ${supplierPhone} NOT sent (continuing; order remains pending_supplier_confirmation):`, JSON.stringify(sendResult));
    }
  } else if (needsOpsConfirmation) {
    const ticket = whatsappService.buildOpsTicketMessage({
      order,
      supplier_name: supplier.name,
      items: validatedItems,
      total_amount: totalOrderAmount,
      delivery_location: orderMeta.delivery_location || null
    });
    const sendResult = await whatsappService.sendTextMessage(opsContactPhone, ticket);
    ticketSent = !!(sendResult && sendResult.success === true);
    if (!ticketSent) {
      console.error(`⚠️ Ops ticket to ${opsContactPhone} NOT sent (continuing; order remains pending_ops_confirmation):`, JSON.stringify(sendResult));
    }
  }

  // Restaurant kitchen ticket: fire-and-forget notification to the client's
  // kitchen line once the customer confirms. Independent of the awaiting-state
  // branches above (the order itself is already 'approved'). Not tied to the
  // ops/supplier status checks, so it fires even if the order carries an ops
  // or supplier status too.
  if (isRestaurant && kitchenPhone) {
    const kitchen = whatsappService.buildKitchenTicketMessage({
      order,
      items: validatedItems,
      total_amount: totalOrderAmount,
      order_type: orderMeta.order_type || null
    });
    const sendResult = await whatsappService.sendTextMessage(kitchenPhone, kitchen);
    const kitchenSent = !!(sendResult && sendResult.success === true);
    ticketSent = ticketSent || kitchenSent;
    if (!kitchenSent) {
      console.error(`⚠️ Kitchen ticket to ${kitchenPhone} NOT sent (continuing):`, JSON.stringify(sendResult));
    }
  }

  return {
    success: true,
    order,
    items: createdItems.map((item, idx) => ({
      ...item,
      product_name: validatedItems[idx].product_name
    })),
    ticket_sent: ticketSent
  };
}

/**
 * Personalized copy for an order that was previously confirmed but can no
 * longer be fulfilled (stock/credit changed between confirmation and now).
 */
function personalizeConfirmationFailure(validation) {
  if (validation.failedProductName) {
    return `Sorry, stock changed since you confirmed — "${validation.failedProductName}" is no longer available.`;
  }
  return `Sorry, something changed since you confirmed this order: ${validation.reason}`;
}

/**
 * Process a parsed order structure.
 *
 * Rejections always create a 'rejected' order row immediately (unchanged).
 * A fully validated order is NOT created yet — with a customer phone it is
 * stored in conversation state for confirmation; without one (direct API
 * test endpoint) it falls back to the legacy immediate create.
 *
 * @param {{ supplier_name: string,
 *           items: Array<{ product_name: string, quantity: number }>,
 *           delivery_location?: string, payment_terms?: string }} parsedOrder
 * @param {string|null} [customerPhone]
 * @param {string} [businessCategory] - 'dropshipper' | 'restaurant' | 'b2b'.
 *   Stored on the pending order so the confirmation message formats per category.
 * @param {string} [businessPhone] - The client's webhook-registered WhatsApp
 *   number (the business that installed the bot). Resolved to the client row
 *   (client_id) to scope every catalog lookup and pick up its
 *   operations_contact_phone for B2B ops routing.
 * @returns {Promise<{ success: boolean, order?: Object|null, items?: Array<Object>,
 *                     reason?: string, customer_message?: string, pending?: boolean,
 *                     confirmation_message?: string,
 *                     pending_order?: Object, parsed_data?: Object }>}
 */
async function processOrderPipeline(parsedOrder, customerPhone = null, businessCategory = undefined, businessPhone = undefined) {
  const { supplier_name, items, delivery_location, payment_terms, order_type } = parsedOrder;
  console.log(`📦 Pipeline: Processing order for supplier "${supplier_name}" with ${items ? items.length : 0} items...`);

  // --- Step 0: Resolve the client (tenant) first — everything downstream is
  //     scoped by client_id. The client is identified by the business's OWN
  //     webhook number (businessPhone), NOT the customer's number. This also
  //     snapshots the business name / ops route for invoices and tickets, and
  //     lets businessCategory fall back to the value stored on the client row.
  let clientContext = null;
  let clientId = null;
  if (businessPhone) {
    const client = await db.getClientByPhone(businessPhone);
    if (client && typeof client === 'object') {
      clientId = client.id || null;
      clientContext = {
        client_id: client.id || null,
        business_name: client.business_name || null,
        operations_contact_phone: client.operations_contact_phone || null,
        kitchen_contact_phone: client.kitchen_contact_phone || null,
        business_category: client.business_category || undefined
      };
      businessCategory = businessCategory || client.business_category;
    }
  }

  // Legacy direct-API (no webhook business number) and dev/dashboard paths fall
  // back to the seeded default tenant so every order still carries a valid
  // client_id foreign key rather than being orphaned.
  if (!clientId) {
    const defaultClient = await db.getDefaultClient();
    if (defaultClient) {
      clientId = defaultClient.id;
      clientContext = clientContext || {
        client_id: defaultClient.id,
        business_name: defaultClient.business_name || null,
        operations_contact_phone: defaultClient.operations_contact_phone || null,
        kitchen_contact_phone: defaultClient.kitchen_contact_phone || null,
        business_category: defaultClient.business_category || undefined
      };
    }
  }

  // --- Step 1: Supplier Verification ---
  const isUnknownSupplier = !supplier_name ||
                            supplier_name.toLowerCase() === 'unknown supplier' ||
                            supplier_name.toLowerCase() === 'unknown' ||
                            supplier_name.toLowerCase() === 'ambiguous';

  let supplier = null;
  if (!isUnknownSupplier) {
    supplier = await db.getSupplierByName(supplier_name, clientId);
  }

  if (!supplier && customerPhone) {
    console.log(`🔍 Pipeline: Supplier "${supplier_name || 'Unknown'}" not resolved. Falling back to phone number search: "${customerPhone}"`);
    supplier = await db.getSupplierByPhone(customerPhone, clientId);
  }

  if (!supplier) {
    const finalSupplierName = supplier_name || 'Unknown Supplier';
    const reason = `Supplier "${finalSupplierName}" not found.`;

    // The audit-trail insert is best-effort: a DB failure here (missing
    // placeholder supplier, network blip, FK violation, etc.) must never
    // surface as a raw exception to the customer — degrade to the normal
    // customer-facing rejection instead.
    let order = null;
    try {
      const placeholderId = await db.getPlaceholderSupplierId(clientId);
      order = await createRejectedOrder(placeholderId, reason, 0.00, clientId);
    } catch (auditError) {
      console.error('❌ Unresolved-supplier rejection audit insert failed (continuing without audit row):', auditError);
      return {
        success: false,
        reason: 'Supplier not found.',
        customer_message: 'Sorry, we couldn\'t find your account. Please contact the business directly.',
        order: null,
        parsed_data: parsedOrder
      };
    }

    return { success: false, reason, order, parsed_data: parsedOrder };
  }

  console.log(`✅ Supplier Found: ${supplier.name} (Credit Limit: ₦${supplier.credit_limit}, Balance: ₦${supplier.outstanding_balance})`);

  // --- Step 1.5: Credit Request Authorization Check ---
  if (supplier.can_request_credit === false) {
    const reason = `Credit request blocked: Supplier "${supplier.name}" is currently restricted from requesting credit.`;
    const order = await createRejectedOrder(supplier.id, reason, 0.00, clientId);
    return { success: false, reason, order };
  }

  // --- Steps 2 & 3: Product / Stock / Credit Validation ---
  const validation = await validateItemsAndCredit(supplier, items, clientId, businessCategory);
  if (!validation.ok) {
    const order = await createRejectedOrder(supplier.id, validation.reason, validation.totalOrderAmount || 0.00, clientId);
    // Restaurant stock-out: give the customer alternatives instead of a flat
    // rejection (message falls back to the generic rejection when none found).
    const customer_message = validation.kind === 'insufficient_stock' && businessCategory === 'restaurant'
      ? whatsappService.buildStockOutMessage({
          failedProductName: validation.failedProductName,
          alternatives: validation.alternatives || []
        })
      : null;
    return { success: false, reason: validation.reason, order, customer_message, alternatives: validation.alternatives };
  }

  const { validatedItems, totalOrderAmount } = validation;

  // --- Step 4: Hold the validated order for customer confirmation ---
  if (customerPhone) {
    const pendingOrderData = {
      supplier_id: supplier.id,
      supplier_name: supplier.name,
      items: validatedItems,
      total_amount: totalOrderAmount,
      client_id: clientId,
      business_category: businessCategory || null,
      business_name: clientContext ? clientContext.business_name : null,
      delivery_location: delivery_location || null,
      payment_terms: payment_terms || null,
      order_type: order_type || null,
      operations_contact_phone: clientContext ? clientContext.operations_contact_phone : null,
      kitchen_contact_phone: clientContext ? clientContext.kitchen_contact_phone : null
    };

    await db.setConversationState(customerPhone, 'awaiting_confirmation', pendingOrderData);
    console.log(`⏳ Pipeline: Validated order held for confirmation from ${customerPhone} (₦${totalOrderAmount.toFixed(2)}). Awaiting YES/NO...`);

    return {
      success: true,
      pending: true,
      confirmation_message: whatsappService.buildPendingConfirmationMessage(pendingOrderData, businessCategory),
      pending_order: pendingOrderData,
      parsed_data: parsedOrder
    };
  }

  // Legacy fallback: no customer phone to key pending state on (e.g. the
  // direct /api/process-order dev endpoint) -> create the order immediately.
  return createApprovedOrder(supplier, validatedItems, totalOrderAmount, null, {
    client_id: clientId,
    business_category: businessCategory || null,
    kitchen_contact_phone: clientContext ? clientContext.kitchen_contact_phone : null,
    order_type: order_type || null
  });
}

/**
 * Confirm a previously held (awaiting_confirmation) order: re-run the same
 * validation, then create the order and clear the conversation state.
 *
 * @param {string} customerPhone
 * @returns {Promise<{ success: boolean, order?: Object, items?: Array<Object>, reason?: string }>}
 */
async function confirmPendingOrder(customerPhone) {
  const conversation = await db.getConversationState(customerPhone);
  const pending = conversation && conversation.pending_order_data;

  if (!customerPhone || !pending || conversation.state !== 'awaiting_confirmation') {
    return { success: false, reason: 'No pending order to confirm.', order: null };
  }

  console.log(`✅ Pipeline: Confirming pending order for ${customerPhone}...`);

  // Resolve the tenant for this held order. It was snapshotted on the pending
  // payload at hold time; fall back to the default tenant for legacy rows held
  // before client scoping existed.
  let clientId = pending.client_id || null;
  if (!clientId) {
    const defaultClient = await db.getDefaultClient();
    clientId = (defaultClient && defaultClient.id) || null;
  }

  // Re-run the same validation pipeline on the stored (already-parsed) data —
  // no AI re-parse. Stock/credit may have changed since the order was held.
  const supplier = await db.getSupplierByName(pending.supplier_name, clientId);
  if (!supplier) {
    await db.clearConversationState(customerPhone);
    const reason = `Supplier "${pending.supplier_name}" no longer found.`;
    const placeholderId = await db.getPlaceholderSupplierId(clientId);
    const order = await createRejectedOrder(placeholderId, reason, 0.00, clientId);
    return { success: false, reason: `Sorry, the supplier you ordered from is no longer available: ${reason}`, order };
  }

  if (supplier.can_request_credit === false) {
    await db.clearConversationState(customerPhone);
    const reason = `Credit request blocked: Supplier "${supplier.name}" is currently restricted from requesting credit.`;
    const order = await createRejectedOrder(supplier.id, reason, 0.00, clientId);
    return { success: false, reason: personalizeConfirmationFailure({ reason }), order };
  }

  const validation = await validateItemsAndCredit(supplier, pending.items, clientId, pending.business_category || null);
  if (!validation.ok) {
    await db.clearConversationState(customerPhone);
    const order = await createRejectedOrder(supplier.id, validation.reason, validation.totalOrderAmount || 0.00, clientId);
    return { success: false, reason: personalizeConfirmationFailure(validation), order };
  }

  const result = await createApprovedOrder(
    supplier,
    validation.validatedItems,
    validation.totalOrderAmount,
    pending.operations_contact_phone || null,
    {
      client_id: clientId,
      delivery_location: pending.delivery_location || null,
      payment_terms: pending.payment_terms || null,
      order_type: pending.order_type || null,
      business_name: pending.business_name || null,
      business_category: pending.business_category || null,
      kitchen_contact_phone: pending.kitchen_contact_phone || null,
      customer_phone: customerPhone || null
    }
  );
  await db.clearConversationState(customerPhone);
  return result;
}

/**
 * Cancel a held (awaiting_confirmation) order: clear the conversation state.
 *
 * @param {string} customerPhone
 * @returns {Promise<{ success: boolean, cancelled: boolean, had_pending: boolean }>}
 */
async function cancelPendingOrder(customerPhone) {
  const conversation = await db.getConversationState(customerPhone);
  await db.clearConversationState(customerPhone);
  console.log(`🗑️ Pipeline: Pending order cancelled for ${customerPhone}.`);
  return {
    success: true,
    cancelled: true,
    had_pending: !!(conversation && conversation.state === 'awaiting_confirmation' && conversation.pending_order_data)
  };
}

/**
 * Process a possible SUPPLIER reply to a dropshipper order waiting on their
 * confirmation ('pending_supplier_confirmation').
 *
 * Disambiguation contract (shared with whatsappController): this only handles
 * the message when `phone` is the WhatsApp number of a supplier belonging to
 * `clientId` (scoped by the business line the message arrived on) AND that
 * tenant has an order awaiting THAT supplier's reply. Anything else returns
 * { handled: false } so normal customer-order handling takes over — this is
 * what lets the same bot server both suppliers and customers, even when a
 * number is both.
 *
 * YES  -> order 'supplier_confirmed', customer is told to pay via the
 *         order's payment link, supplier is acked.
 * NO   -> order 'supplier_declined', customer is told the supplier declined.
 * other-> re-prompt the supplier (order stays 'pending_supplier_confirmation').
 *
 * @param {string} phone - the sender's WhatsApp number (message.from)
 * @param {string|null} clientId - tenant resolved from the business line
 * @param {string} text - the raw message text
 * @returns {Promise<{ handled: boolean, action?: 'confirmed'|'declined'|'re_prompt', order?: Object }>}
 */
async function processSupplierReply(phone, clientId, text) {
  const order = await db.getAwaitingSupplierOrder(phone, clientId);
  if (!order) {
    return { handled: false };
  }

  const shortId = String(order.id).slice(0, 8).toUpperCase();
  const reply = String(text || '').trim().toLowerCase();
  const YES_WORDS = ['yes', 'y', 'confirm', 'confirmed'];
  const NO_WORDS = ['no', 'n', 'decline', 'declined', 'cancel'];

  const notifySupplier = (message) => whatsappService.sendTextMessage(phone, message);

  if (YES_WORDS.includes(reply)) {
    await db.updateOrderStatus(order.id, 'supplier_confirmed', clientId);
    await notifySupplier(`✅ Thanks — order #${shortId} confirmed. We'll let the customer know.`);
    // Seller (the client's own business line) is told the order is approved and
    // how to release it; the PAYMENT LINK is deliberately NOT sent to the
    // customer yet — it ships with buildOrderReadyMessage when the seller
    // replies "READY <short>" (see processSellerReadyCommand).
    const seller = clientId ? await db.getClientById(clientId) : null;
    if (seller && seller.whatsapp_number) {
      const supplier = await db.getSupplierByPhone(phone, clientId);
      await whatsappService.sendTextMessage(
        seller.whatsapp_number,
        whatsappService.buildSellerReadyPrompt({
          order,
          supplier_name: (supplier && supplier.name) || 'Supplier',
          total_amount: order.total_amount
        })
      );
    }
    if (order.customer_phone) {
      await whatsappService.sendTextMessage(
        order.customer_phone,
        `✅ Supplier confirmed your order!\n\n` +
        `Order #${shortId}\n` +
        `Total: ₦${Number(order.total_amount).toFixed(2)}\n` +
        `We're preparing it — you'll get the payment link when it's ready.`
      );
    }
    console.log(`✅ Supplier reply: order ${order.id} confirmed by supplier ${phone}.`);
    return { handled: true, action: 'confirmed', order };
  }

  if (NO_WORDS.includes(reply)) {
    await db.updateOrderStatus(order.id, 'supplier_declined', clientId);
    await notifySupplier(`OK — order #${shortId} marked as declined.`);
    if (order.customer_phone) {
      await whatsappService.sendTextMessage(
        order.customer_phone,
        `❌ The supplier couldn't fulfill order #${shortId} at this time.\n\nPlease send a new order or contact the business.`
      );
    }
    console.log(`❌ Supplier reply: order ${order.id} declined by supplier ${phone}.`);
    return { handled: true, action: 'declined', order };
  }

  // Ambiguous -> re-prompt, anchored to the order reference. Do NOT fall through
  // to normal order parsing for a known awaiting supplier.
  await notifySupplier(`Please reply YES to confirm or NO to decline order #${shortId}.`);
  return { handled: true, action: 're_prompt', order };
}

/**
 * Process a possible OPS-CONTACT reply to a b2b order waiting on stock
 * confirmation ('pending_ops_confirmation'). This is the ops twin of
 * processSupplierReply (Rule 1b in whatsappController): it only handles the
 * message when `phone` is the tenant's OWN operations_contact_phone AND that
 * tenant has an order still waiting on ops approval (oldest first). Any other
 * sender/order returns { handled: false } so supplier/customer handling and
 * fresh-order parsing take over.
 *
 * An order can never be matched by BOTH this rule and the supplier rule: order
 * creation picks supplier-confirmation over ops-confirmation, so a given order
 * is in exactly one of the two awaiting states.
 *
 * YES  -> order 'approved', ops acked, customer told the order is confirmed,
 *         seller gets the PROGRESS/READY prompt.
 * NO   -> order 'ops_declined', ops acked, customer told the business could
 *         not fulfill the order.
 * other-> re-prompt the ops contact (order stays 'pending_ops_confirmation').
 *
 * @param {string} phone - the sender's WhatsApp number (message.from)
 * @param {string|null} clientId - tenant resolved from the business line
 * @param {string} text - the raw message text
 * @returns {Promise<{ handled: boolean, action?: 'approved'|'ops_declined'|'re_prompt', order?: Object }>}
 */
async function processOpsReply(phone, clientId, text) {
  const order = await db.getAwaitingOpsOrder(phone, clientId);
  if (!order) {
    return { handled: false };
  }

  const shortId = String(order.id).slice(0, 8).toUpperCase();
  const reply = String(text || '').trim().toLowerCase();
  const YES_WORDS = ['yes', 'y', 'confirm', 'confirmed'];
  const NO_WORDS = ['no', 'n', 'decline', 'declined', 'cancel'];

  const notifyOps = (message) => whatsappService.sendTextMessage(phone, message);

  if (YES_WORDS.includes(reply)) {
    await db.updateOrderStatus(order.id, 'approved', clientId);
    await notifyOps(`✅ Thanks — order #${shortId} confirmed. We'll let the customer know.`);
    // The seller (client's own business line) is told the order is approved and
    // how to release it; the payment link still ships via buildOrderReadyMessage
    // when the seller replies READY <short>.
    const seller = clientId ? await db.getClientById(clientId) : null;
    if (seller && seller.whatsapp_number) {
      const supplier = order.supplier_id ? await db.getSupplierById(order.supplier_id, clientId) : null;
      await whatsappService.sendTextMessage(
        seller.whatsapp_number,
        whatsappService.buildSellerReadyPrompt({
          order,
          supplier_name: (supplier && supplier.name) || 'Supplier',
          total_amount: order.total_amount
        })
      );
    }
    if (order.customer_phone) {
      await whatsappService.sendTextMessage(
        order.customer_phone,
        `✅ Your order is confirmed!\n\n` +
        `Order #${shortId}\n` +
        `Total: ₦${Number(order.total_amount).toFixed(2)}\n` +
        `We'll let you know when it's ready.`
      );
    }
    console.log(`✅ Ops reply: order ${order.id} approved by ops contact ${phone}.`);
    return { handled: true, action: 'approved', order };
  }

  if (NO_WORDS.includes(reply)) {
    await db.updateOrderStatus(order.id, 'ops_declined', clientId);
    await notifyOps(`OK — order #${shortId} marked as declined.`);
    if (order.customer_phone) {
      await whatsappService.sendTextMessage(
        order.customer_phone,
        `❌ The business couldn't fulfill order #${shortId} at this time.\n\nPlease send a new order or contact the business.`
      );
    }
    console.log(`❌ Ops reply: order ${order.id} declined by ops contact ${phone}.`);
    return { handled: true, action: 'ops_declined', order };
  }

  // Ambiguous -> re-prompt, anchored to the order reference. Do NOT fall
  // through to normal order parsing for a known awaiting-ops tenant.
  await notifyOps(`Please reply YES to confirm stock or NO to decline order #${shortId}.`);
  return { handled: true, action: 're_prompt', order };
}

/**
 * Process a possible SELLER "READY <order_id_short>" command: the client's own
 * WhatsApp line marks a supplier-confirmed order ready_for_customer, which
 * auto-notifies the customer with the payment link.
 *
 * Disambiguation contract (shared with whatsappController): this only handles
 * the message when the text matches /^READY\s+<short|full id>$/i AND the sender
 * is the client's own business number. An exact "READY ..." command from anyone
 * else is still consumed (returned handled -> 'unauthorized') so it can't be
 * misread as a new order; non-READY text falls through to normal handling.
 *
 * @param {string} from - the sender's WhatsApp number (message.from)
 * @param {string|null} clientId - tenant resolved from the business line
 * @param {string} text - the raw message text
 * @returns {Promise<{ handled: boolean, action?: 'ready'|'not_found'|'unauthorized', order?: Object|null }>}
 */
async function processSellerReadyCommand(from, clientId, text) {
  const match = String(text || '').trim().match(/^READY\s+([A-Za-z0-9-]{4,40})$/i);
  if (!match) {
    return { handled: false };
  }

  const ref = String(match[1]).toUpperCase().replace(/\s+/g, '');

  if (!clientId) {
    return { handled: true, action: 'unauthorized', order: null };
  }

  const seller = clientId ? await db.getClientById(clientId) : null;
  const clean = (num) => String(num || '').replace(/\D/g, '');
  const isOwner = seller && seller.whatsapp_number && clean(seller.whatsapp_number) === clean(from);

  if (!isOwner) {
    console.warn(`🚫 Seller READY command from non-owner ${from} (client ${clientId}) ignored.`);
    return { handled: true, action: 'unauthorized', order: null };
  }

  const order = await db.getOrderByShortReference(ref, clientId, ['supplier_confirmed', 'approved', 'in_progress']);
  if (!order) {
    await whatsappService.sendTextMessage(from, `❌ No order #${ref} found that is ready to release.`);
    return { handled: true, action: 'not_found', order: null };
  }

  await db.updateOrderStatus(order.id, 'ready_for_customer', clientId);
  const shortId = String(order.id).slice(0, 8).toUpperCase();

  if (order.customer_phone) {
    await whatsappService.sendTextMessage(
      order.customer_phone,
      whatsappService.buildOrderReadyMessage({
        orderId: order.id,
        total_amount: order.total_amount,
        payment_link: order.payment_link
      })
    );
  }

  await whatsappService.sendTextMessage(from, `✅ Order #${shortId} marked ready — customer notified.`);
  console.log(`🎉 Seller READY: order ${order.id} -> ready_for_customer (customer notified).`);
  return { handled: true, action: 'ready', order };
}

/**
 * Process a "PROGRESS <ref>" seller command — the mirror of the READY
 * command. Same disambiguation contract (Rule 0 in whatsappController): an
 * exact /^PROGRESS\s+<ref>$/i from the client's OWN business line against a
 * confirmed-but-not-yet-ready order.
 *
 * An eligible order must currently be in a "confirmed, awaiting progress"
 * state — ['approved', 'supplier_confirmed']. It is moved to 'in_progress'
 * and the customer is auto-notified with a preparation milestone. An order
 * already in 'in_progress' is consumed with a note to the seller (no customer
 * spam); anything else is not handled (falls through to normal handling).
 *
 * @param {string} from - the sender's WhatsApp number (message.from)
 * @param {string|null} clientId - tenant resolved from the business line
 * @param {string} text - the raw message text
 * @returns {Promise<{ handled: boolean, action?: 'progress'|'already_in_progress'|'not_found'|'unauthorized', order?: Object|null }>}
 */
async function processSellerProgressCommand(from, clientId, text) {
  const match = String(text || '').trim().match(/^PROGRESS\s+([A-Za-z0-9-]{4,40})$/i);
  if (!match) {
    return { handled: false };
  }

  const ref = String(match[1]).toUpperCase().replace(/\s+/g, '');

  if (!clientId) {
    return { handled: true, action: 'unauthorized', order: null };
  }

  const seller = clientId ? await db.getClientById(clientId) : null;
  const clean = (num) => String(num || '').replace(/\D/g, '');
  const isOwner = seller && seller.whatsapp_number && clean(seller.whatsapp_number) === clean(from);

  if (!isOwner) {
    console.warn(`🚫 Seller PROGRESS command from non-owner ${from} (client ${clientId}) ignored.`);
    return { handled: true, action: 'unauthorized', order: null };
  }

  const order = await db.getOrderByShortReference(ref, clientId, ['approved', 'supplier_confirmed']);
  if (!order) {
    const already = await db.getOrderByShortReference(ref, clientId, 'in_progress');
    if (already) {
      await whatsappService.sendTextMessage(from, `ℹ️ Order #${String(already.id).slice(0, 8).toUpperCase()} is already in progress.`);
      return { handled: true, action: 'already_in_progress', order: already };
    }
    await whatsappService.sendTextMessage(from, `❌ No confirmed order #${ref} found to mark in progress.`);
    return { handled: true, action: 'not_found', order: null };
  }

  await db.updateOrderStatus(order.id, 'in_progress', clientId);
  const shortId = String(order.id).slice(0, 8).toUpperCase();

  if (order.customer_phone) {
    await whatsappService.sendTextMessage(
      order.customer_phone,
      whatsappService.buildOrderProgressMessage({ orderId: order.id })
    );
  }

  await whatsappService.sendTextMessage(from, `✅ Order #${shortId} marked in progress — customer notified.`);
  console.log(`🍳 Seller PROGRESS: order ${order.id} -> in_progress (customer notified).`);
  return { handled: true, action: 'progress', order };
}

module.exports = {
  processOrderPipeline,
  confirmPendingOrder,
  cancelPendingOrder,
  processSupplierReply,
  processOpsReply,
  processSellerReadyCommand,
  processSellerProgressCommand,
  CONFIRMATION_TIMEOUT_MINUTES,
  isConfirmationExpired
};