/**
 * Order Service
 * 
 * Manages the B2B order pipeline validation rules:
 * 1. Matches supplier and products
 * 2. Checks inventory levels
 * 3. Validates supplier credit availability
 * 4. Executes transaction updates (balance & stock)
 * 5. Generates payment links and order records
 */

const db = require('../config/db');

/**
 * Process a parsed order structure
 * @param {{ supplier_name: string, items: Array<{ product_name: string, quantity: number }> }} parsedOrder
 * @returns {Promise<{ success: boolean, order: Object, items?: Array<Object>, reason?: string }>}
 */
async function processOrderPipeline(parsedOrder, senderPhone = null) {
  const { supplier_name, items } = parsedOrder;
  console.log(`📦 Pipeline: Processing order for supplier "${supplier_name}" with ${items ? items.length : 0} items...`);

  // --- Step 1: Supplier Verification ---
  const isUnknownSupplier = !supplier_name || 
                            supplier_name.toLowerCase() === 'unknown supplier' || 
                            supplier_name.toLowerCase() === 'unknown' || 
                            supplier_name.toLowerCase() === 'ambiguous';

  let supplier = null;
  if (!isUnknownSupplier) {
    supplier = await db.getSupplierByName(supplier_name);
  }

  if (!supplier && senderPhone) {
    console.log(`🔍 Pipeline: Supplier "${supplier_name || 'Unknown'}" not resolved. Falling back to phone number search: "${senderPhone}"`);
    supplier = await db.getSupplierByPhone(senderPhone);
  }

  if (!supplier) {
    const finalSupplierName = supplier_name || 'Unknown Supplier';
    console.warn(`⚠️ Pipeline Rejected: Supplier "${finalSupplierName}" not found in database.`);
    return {
      success: false,
      reason: `Supplier "${finalSupplierName}" not found.`,
      parsed_data: parsedOrder
    };
  }

  console.log(`✅ Supplier Found: ${supplier.name} (Credit Limit: $${supplier.credit_limit}, Balance: $${supplier.outstanding_balance})`);


  // --- Step 1.5: Credit Request Authorization Check ---
  if (supplier.can_request_credit === false) {
    const reason = `Credit request blocked: Supplier "${supplier.name}" is currently restricted from requesting credit.`;
    console.warn(`⚠️ Pipeline Rejected: ${reason}`);
    const order = await db.createOrder({
      supplier_id: supplier.id,
      status: 'rejected',
      status_reason: reason,
      total_amount: 0.00,
      payment_status: 'pending'
    });
    return { success: false, reason, order };
  }

  if (!items || items.length === 0) {
    // If AI found no products in the message
    const order = await db.createOrder({
      supplier_id: supplier.id,
      status: 'rejected',
      status_reason: 'No products detected in order message.',
      total_amount: 0.00,
      payment_status: 'pending'
    });
    return { success: false, reason: 'No products detected in order message.', order };
  }

  // --- Step 2: Product & Stock Validation ---
  const validatedItems = [];
  let totalOrderAmount = 0;

  for (const item of items) {
    const product = await db.getProductByName(item.product_name);
    
    // Product does not exist
    if (!product) {
      const reason = `Product "${item.product_name}" not found.`;
      console.warn(`⚠️ Pipeline Rejected: ${reason}`);
      const order = await db.createOrder({
        supplier_id: supplier.id,
        status: 'rejected',
        status_reason: reason,
        total_amount: 0.00,
        payment_status: 'pending'
      });
      return { success: false, reason, order };
    }

    // Insufficient stock
    if (item.quantity > product.stock_quantity) {
      const reason = `Insufficient stock for "${product.name}" (requested: ${item.quantity}, available: ${product.stock_quantity}).`;
      console.warn(`⚠️ Pipeline Rejected: ${reason}`);
      const order = await db.createOrder({
        supplier_id: supplier.id,
        status: 'rejected',
        status_reason: reason,
        total_amount: 0.00,
        payment_status: 'pending'
      });
      return { success: false, reason, order };
    }

    const itemTotal = parseFloat((product.price * item.quantity).toFixed(2));
    totalOrderAmount += itemTotal;

    validatedItems.push({
      product_id: product.id,
      product_name: product.name,
      quantity: item.quantity,
      unit_price: product.price,
      item_total: itemTotal
    });
  }

  totalOrderAmount = parseFloat(totalOrderAmount.toFixed(2));

  // --- Step 3: Supplier Credit Check ---
  const availableCredit = parseFloat((supplier.credit_limit - supplier.outstanding_balance).toFixed(2));
  if (totalOrderAmount > availableCredit) {
    const reason = `Credit limit exceeded. Order total: $${totalOrderAmount.toFixed(2)}, Available credit: $${availableCredit.toFixed(2)}.`;
    console.warn(`⚠️ Pipeline Rejected: ${reason}`);
    
    const order = await db.createOrder({
      supplier_id: supplier.id,
      status: 'rejected',
      status_reason: reason,
      total_amount: totalOrderAmount,
      payment_status: 'pending'
    });
    
    return { success: false, reason, order };
  }

  // --- Step 4: Create Approved Order and Apply Stock/Balance Updates ---
  console.log(`✅ Order Approved! Total amount: $${totalOrderAmount.toFixed(2)}. Applying updates...`);

  // 4a. Create the approved order first to get an ID
  const order = await db.createOrder({
    supplier_id: supplier.id,
    status: 'approved',
    status_reason: 'All checks passed successfully.',
    total_amount: totalOrderAmount,
    payment_status: 'pending',
    payment_link: 'MOCK_PENDING' // Placeholder to update
  });

  // 4b. Generate payment link containing the order UUID
  const paymentLink = `https://checkout.teapipeline.com/pay/${order.id}`;
  
  // Real database will require updating the field or we can just build it ahead in real code.
  // In our db repo helper, we return the record and can update it. Let's make sure order contains the generated link.
  order.payment_link = paymentLink;
  
  // If real Supabase is used, let's update it in the database
  if (!db.isMock) {
    // Note: Since we are in service_role we can directly update it
    const { createClient } = require('@supabase/supabase-js');
    const supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    await supabaseClient
      .from('orders')
      .update({ payment_link: paymentLink })
      .eq('id', order.id);
  } else {
    // Mock db update of payment link
    const fs = require('fs');
    const path = require('path');
    const MOCK_DB_PATH = path.join(__dirname, '../../db/mock_db.json');
    const mockData = JSON.parse(fs.readFileSync(MOCK_DB_PATH, 'utf8'));
    const mockOrder = mockData.orders.find(o => o.id === order.id);
    if (mockOrder) {
      mockOrder.payment_link = paymentLink;
      fs.writeFileSync(MOCK_DB_PATH, JSON.stringify(mockData, null, 2), 'utf8');
    }
  }

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
  });

  console.log(`🎉 Pipeline Completed: Order ${order.id} processed successfully.`);

  return {
    success: true,
    order,
    items: createdItems.map((item, idx) => ({
      ...item,
      product_name: validatedItems[idx].product_name
    }))
  };
}

module.exports = {
  processOrderPipeline
};
