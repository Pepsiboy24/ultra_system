/**
 * Unified Database Interface (Repository Pattern)
 * 
 * Automatically switches between a real Supabase client and a local JSON mock database
 * based on whether valid environment variables are defined.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// __dirname is not provided by the Cloudflare Workers CJS runtime (only Node).
// Mock JSON is only read in local mock mode, never under the Workers runtime,
// so a static fallback is sufficient there.
const MOCK_DB_PATH = path.join(
  typeof __dirname !== 'undefined' ? __dirname : '.',
  '../../db/mock_db.json'
);

// Fixed ID of the internal/placeholder "Unknown Supplier" row used to keep an
// audit trail for orders whose supplier could not be resolved (orders.supplier_id
// is NOT NULL). Must match the seed in scripts/seed.js.
const UNKNOWN_SUPPLIER_ID = '00000000-0000-4000-8000-000000000001';

// Check if real Supabase environment is fully configured
function isSupabaseConfigured() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return (
    url && 
    key && 
    url !== 'https://your-project-id.supabase.co' && 
    key !== 'your-supabase-service-role-key' &&
    url.startsWith('https://')
  );
}

const isMock = !isSupabaseConfigured();
let supabase = null;

if (!isMock) {
  console.log('⚡ Pipeline DB: Configured to use real Supabase instance.');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
} else {
  console.log('⚡ Pipeline DB: Configured to use local MOCK simulation mode.');
}

// Helper: Read mock database from JSON file
function readMockDb() {
  if (!fs.existsSync(MOCK_DB_PATH)) {
    throw new Error('Mock database file not found. Please run "npm run seed" first.');
  }
  const raw = fs.readFileSync(MOCK_DB_PATH, 'utf8');
  return JSON.parse(raw);
}

// Helper: Write mock database to JSON file
function writeMockDb(data) {
  fs.writeFileSync(MOCK_DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// Helper: Bidirectional case-insensitive substring match.
// Returns true if EITHER string contains the other, so both
// "search term shorter than catalog name" and
// "search term longer than catalog name" directions match.
function namesOverlap(catalogName, searchName) {
  const catalog = String(catalogName || '').toLowerCase();
  const search = String(searchName || '').toLowerCase();
  if (!catalog || !search) return false;
  return catalog.includes(search) || search.includes(catalog);
}

/**
 * Data Repository API
 */
const db = {
  isMock,
  UNKNOWN_SUPPLIER_ID,

  /**
   * Look up a supplier by name using case-insensitive partial match.
   * Scoped to a client: the supplier must belong to clientId.
   */
  async getSupplierByName(name, clientId = null) {
    if (!name) return null;
    
    if (!isMock) {
      // Find matching supplier using Supabase ilike (catalog-contains-search direction)
      let query = supabase.from('suppliers').select('*');
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query
        .ilike('name', `%${name}%`)
        .limit(1);

      if (error) {
        console.error('Error fetching supplier from Supabase:', error);
        return null;
      }
      if (data && data.length > 0) {
        return data[0];
      }

      // ilike misses the reverse direction (search term contains catalog name).
      // Fall back to client-side bidirectional matching.
      let allQuery = supabase.from('suppliers').select('*');
      if (clientId) allQuery = allQuery.eq('client_id', clientId);
      const { data: all, error: allError } = await allQuery;

      if (allError) {
        console.error('Error fetching all suppliers from Supabase:', allError);
        return null;
      }
      return (all || []).find(s => namesOverlap(s.name, name)) || null;
    } else {
      // Local mock search (bidirectional substring match)
      const data = readMockDb();
      const scoped = data.suppliers.filter(s => !clientId || s.client_id === clientId);
      const found = scoped.find(s => namesOverlap(s.name, name));
      return found || null;
    }
  },

  /**
   * Look up a supplier by contact phone (scoped to a client).
   */
  async getSupplierByPhone(phone, clientId = null) {
    if (!phone) return null;

    if (!isMock) {
      // Find matching supplier by contact_phone in Supabase
      let query = supabase.from('suppliers').select('*');
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query
        .eq('contact_phone', phone)
        .limit(1);

      if (error) {
        console.error('Error fetching supplier by phone from Supabase:', error);
        return null;
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      // Local mock search
      const data = readMockDb();
      const cleanPhone = phone.replace(/\D/g, '');
      const scoped = data.suppliers.filter(s => !clientId || s.client_id === clientId);
      const found = scoped.find(s => {
        if (!s.contact_phone) return false;
        const cleanContact = s.contact_phone.replace(/\D/g, '');
        return cleanContact === cleanPhone || s.contact_phone === phone;
      });
      return found || null;
    }
  },


  /**
   * Look up a client (the tenant/business that installed the bot) by its
   * WhatsApp number. This is the business's OWN line the customer messaged
   * (inbound webhook value.metadata.display_phone_number), NOT the customer's
   * number in message.from.
   *
   * Lookup is format-tolerant: both sides are normalized to non-digits, so
   * "+2348000000001" and "2348000000001" resolve to the same client — the same
   * normalization getSupplierByPhone already applies.
   *
   * TODO(multi-tenant): seed holds a single client for now, but multiple rows
   * are supported here; the resolved row drives business_category and the ops
   * route fields. When a business number matches no client we log loudly and
   * return null (caller falls back to generic b2b) rather than misroute.
   */
  async getClientByPhone(businessWhatsappNumber) {
    if (!businessWhatsappNumber) return null;

    const cleanPhone = businessWhatsappNumber.replace(/\D/g, '');

    const match = (clients) => {
      const found = clients.find(c =>
        (c.whatsapp_number && c.whatsapp_number.replace(/\D/g, '') === cleanPhone) ||
        c.whatsapp_number === businessWhatsappNumber
      );
      return found || null;
    };

    let client;
    if (!isMock) {
      const { data, error } = await supabase.from('clients').select('*');
      if (error) {
        console.error('Error fetching clients from Supabase:', error);
        return null;
      }
      client = match(data || []);
    } else {
      client = match(readMockDb().clients || []);
    }

    if (!client) {
      console.warn(`⚠️ MULTI-TENANT: WhatsApp business number "${businessWhatsappNumber}" (normalized: ${cleanPhone}) matched NO client — check clients.whatsapp_number against the webhook metadata.display_phone_number. Falling back to generic category.`);
    }
    return client;
  },


  /**
   * Fetch a client row by primary key. Used by the payment service to read a
   * tenant's settlement profile / Monnify sub-account code.
   */
  async getClientById(id) {
    if (!id) return null;
    if (!isMock) {
      const { data, error } = await supabase.from('clients').select('*').eq('id', id);
      if (error) {
        console.error('Error fetching client by id from Supabase:', error);
        return null;
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      return (data.clients || []).find(c => c.id === id) || null;
    }
  },

  /**
   * Persist a client's payment-routing profile (settlement bank details + the
   * Monnify sub-account code created from them). Only the fields supplied are
   * written.
   */
  async setClientPaymentProfile(clientId, { settlement_account_number, settlement_bank_code, settlement_email, monnify_subaccount_code } = {}) {
    if (!clientId) throw new Error('setClientPaymentProfile requires clientId.');
    const fields = { settlement_account_number, settlement_bank_code, settlement_email, monnify_subaccount_code };

    if (!isMock) {
      const { data, error } = await supabase
        .from('clients')
        .update(fields)
        .eq('id', clientId)
        .select();
      if (error) {
        throw new Error(`Failed to update client payment profile in Supabase: ${error.message}`);
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      const client = (data.clients || []).find(c => c.id === clientId);
      if (!client) return null;
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) client[key] = value;
      }
      writeMockDb(data);
      return client;
    }
  },

  /**
   * Look up a product by name using case-insensitive partial match.
   * Scoped to a client: the product must belong to clientId.
   */
  async getProductByName(name, clientId = null) {
    if (!name) return null;

    if (!isMock) {
      let query = supabase.from('products').select('*');
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query
        .ilike('name', `%${name}%`)
        .limit(1);

      if (error) {
        console.error('Error fetching product from Supabase:', error);
        return null;
      }
      if (data && data.length > 0) {
        return data[0];
      }

      // ilike only covers the catalog-contains-search direction. If it found
      // nothing, check whether the search term merely CONTAINS a catalog name
      // (e.g. "cartons of Earl Grey Blend" -> "Earl Grey Blend") client-side.
      let allQuery = supabase.from('products').select('*');
      if (clientId) allQuery = allQuery.eq('client_id', clientId);
      const { data: all, error: allError } = await allQuery;

      if (allError) {
        console.error('Error fetching all products from Supabase:', allError);
        return null;
      }
      return (all || []).find(p => namesOverlap(p.name, name)) || null;
    } else {
      const data = readMockDb();
      const scoped = data.products.filter(p => !clientId || p.client_id === clientId);
      const found = scoped.find(p => namesOverlap(p.name, name));
      return found || null;
    }
  },

  /**
   * Suggest in-stock alternative products for a restaurant stock-out.
   *
   * Ranking (up to `limit`, default 2):
   *   1. Products in the SAME category as the unavailable item (stock > 0,
   *      excluding the unavailable item), closest by price first.
   *   2. If there are no in-stock same-category matches (or the item has no
   *      category), the nearest-priced in-stock products in the client catalog.
   *
   * @param {Object} params
   * @param {string} params.clientId - Tenant whose catalog to search.
   * @param {string} params.excludeName - The unavailable product name (skip it).
   * @param {string|null} params.category - The unavailable item's category.
   * @param {number} params.referencePrice - Price of the unavailable item, used
   *   for nearest-price ranking.
   * @param {number} [params.limit]
   * @returns {Promise<Array<Object>>} Product rows (name, price, category, stock_quantity).
   */
  async getInStockAlternatives({ clientId, excludeName, category, referencePrice, limit = 2 }) {
    if (!clientId) return [];

    const rank = (products) => {
      const inStock = (products || []).filter(p =>
        p.name !== excludeName &&
        Number(p.stock_quantity) > 0
      );
      const sameCategory = category
        ? inStock.filter(p => p.category && String(p.category).toLowerCase() === String(category).toLowerCase())
        : [];
      const pool = sameCategory.length > 0 ? sameCategory : inStock;
      return pool
        .sort((a, b) => Math.abs(Number(a.price) - referencePrice) - Math.abs(Number(b.price) - referencePrice))
        .slice(0, limit);
    };

    if (!isMock) {
      let query = supabase.from('products').select('*');
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query;
      if (error) {
        console.error('Error fetching products for alternatives from Supabase:', error);
        return [];
      }
      return rank(data || []);
    } else {
      const data = readMockDb();
      const scoped = data.products.filter(p => !clientId || p.client_id === clientId);
      return rank(scoped);
    }
  },

  /**
   * Create a new order record (scoped to a client via client_id).
   */
  async createOrder({ client_id, supplier_id, status, status_reason = null, total_amount, payment_status = 'pending', payment_link = null, invoice_url = null, business_name = null, delivery_location = null, payment_terms = null, customer_phone = null }) {
    if (!isMock) {
      const { data, error } = await supabase
        .from('orders')
        .insert([{
          client_id,
          supplier_id,
          status,
          status_reason,
          total_amount,
          payment_status,
          //payment_link: provided via updateOrderPaymentLink after insert
          business_name,
          delivery_location,
          payment_terms,
          customer_phone
        }])
        .select();

      if (error) {
        throw new Error(`Failed to create order in Supabase: ${error.message}`);
      }
      return data[0];
    } else {
      const data = readMockDb();
      const newOrder = {
        id: `ord-${Math.random().toString(36).substr(2, 9)}`,
        client_id,
        supplier_id,
        status,
        status_reason,
        total_amount: parseFloat(total_amount),
        payment_status,
        business_name,
        delivery_location,
        payment_terms,
        customer_phone,
        created_at: new Date().toISOString()
      };
      
      data.orders.push(newOrder);
      writeMockDb(data);
      return newOrder;
    }
  },

  /**
   * Update an order's payment link.
   * Kept as a separate step because the payment link embeds the order UUID,
   * which only exists after the order row is created.
   * When clientId is provided it acts as a tenant guard on the update.
   */
  async updateOrderPaymentLink(orderId, paymentLink, clientId = null) {
    if (!isMock) {
      let query = supabase.from('orders').update({ payment_link: paymentLink }).eq('id', orderId);
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query.select();

      if (error) {
        throw new Error(`Failed to update payment link in Supabase: ${error.message}`);
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      const order = data.orders.find(o => o.id === orderId && (!clientId || o.client_id === clientId));
      if (!order) return null;
      order.payment_link = paymentLink;
      writeMockDb(data);
      return order;
    }
  },

  /**
   * Update an order's invoice URL (hosted HTML invoice page).
   * When clientId is provided it acts as a tenant guard on the update.
   */
async updateOrderInvoiceUrl(orderId, invoiceUrl, clientId = null) {
    if (!isMock) {
      let query = supabase.from('orders').update({ invoice_url: invoiceUrl }).eq('id', orderId);
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query.select();

      if (error) {
        throw new Error(`Failed to update invoice url in Supabase: ${error.message}`);
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      const order = data.orders.find(o => o.id === orderId && (!clientId || o.client_id === clientId));
      if (!order) return null;
      order.invoice_url = invoiceUrl;
      writeMockDb(data);
      return order;
    }
  },

  /**
   * Persist the Monnify transaction reference on an order for reconciliation.
   * When clientId is provided it acts as a tenant guard on the update.
   */
  async updateOrderTransactionReference(orderId, transactionReference, clientId = null) {
    if (!isMock) {
      let query = supabase.from('orders').update({ payment_transaction_reference: transactionReference }).eq('id', orderId);
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query.select();

      if (error) {
        throw new Error(`Failed to update transaction reference in Supabase: ${error.message}`);
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      const order = data.orders.find(o => o.id === orderId && (!clientId || o.client_id === clientId));
      if (!order) return null;
      order.payment_transaction_reference = transactionReference;
      writeMockDb(data);
      return order;
    }
  },

  /**
   * Mark an order as paid (payment_status -> 'paid'). Idempotency is the
   * caller's responsibility (check current status first); this is a pure write.
   * When clientId is provided it acts as a tenant guard on the update.
   */
  async updateOrderPaymentStatus(orderId, paymentStatus, clientId = null) {
    if (!isMock) {
      let query = supabase.from('orders').update({ payment_status: paymentStatus }).eq('id', orderId);
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query.select();

      if (error) {
        throw new Error(`Failed to update payment status in Supabase: ${error.message}`);
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      const order = data.orders.find(o => o.id === orderId && (!clientId || o.client_id === clientId));
      if (!order) return null;
      order.payment_status = paymentStatus;
      writeMockDb(data);
      return order;
    }
  },

  /**
   * Fetch a single order row by its stored Monnify transaction reference
   * (payment_transaction_reference). This is how an incoming payment webhook is
   * matched back to the order it paid for.
   * When clientId is provided it acts as a tenant guard on the lookup.
   */
  async getOrderByTransactionReference(transactionReference, clientId = null) {
    if (!transactionReference) return null;

    if (!isMock) {
      let query = supabase.from('orders').select('*').eq('payment_transaction_reference', transactionReference);
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query.maybeSingle();

      if (error) {
        console.error('Error fetching order by transaction reference from Supabase:', error);
        return null;
      }
      return data;
    } else {
      const data = readMockDb();
      return data.orders.find(o => o.payment_transaction_reference === transactionReference && (!clientId || o.client_id === clientId)) || null;
    }
  },

  /**
   * Set an order's status (e.g. 'supplier_confirmed' / 'supplier_declined').
   * When clientId is provided it acts as a tenant guard on the update.
   */
  async updateOrderStatus(orderId, status, clientId = null) {
    if (!isMock) {
      let query = supabase.from('orders').update({ status }).eq('id', orderId);
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query.select();

      if (error) {
        throw new Error(`Failed to update order status in Supabase: ${error.message}`);
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      const order = data.orders.find(o => o.id === orderId && (!clientId || o.client_id === clientId));
      if (!order) return null;
      order.status = status;
      writeMockDb(data);
      return order;
    }
  },

  /**
   * Find the NEWEST-first match of an order by its SHORT id prefix (first 8
   * chars of the UUID, e.g. "ORD-ABC123" from "ord-abc123..."), optionally
   * constrained to one status OR a list of eligible statuses (array). Used by
   * the seller "READY <short>" / "PROGRESS <short>" commands, scoped hard to
   * clientId — a short id is only meaningful within one tenant.
   */
  async getOrderByShortReference(shortReference, clientId = null, status = null) {
    if (!shortReference || !clientId) return null;
    const ref = String(shortReference).toUpperCase();
    const statusList = Array.isArray(status) ? status : (status ? [status] : null);

    if (!isMock) {
      let query = supabase.from('orders').select('*').eq('client_id', clientId);
      if (statusList) query = query.in('status', statusList);
      query = query.ilike('id', `${ref}%`).order('created_at', { ascending: false }).limit(1);
      const { data, error } = await query;

      if (error) {
        console.error('Error fetching order by short reference from Supabase:', error);
        return null;
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      return data.orders
        .filter(o => o.client_id === clientId && (!statusList || statusList.includes(o.status)))
        .find(o => String(o.id).toUpperCase().startsWith(ref)) || null;
    }
  },

  /**
   * Find the oldest order currently awaiting confirmation from a specific
   * supplier ('pending_supplier_confirmation'). This is the disambiguation
   * anchor for supplier replies: it only matches when the given phone is a
   * supplier of this tenant (clientId) AND that supplier has an order waiting
   * on their YES/NO — nothing else.
   */
  async getAwaitingSupplierOrder(phone, clientId = null) {
    if (!phone || !clientId) return null;
    const supplier = await this.getSupplierByPhone(phone, clientId);
    if (!supplier) return null;

    if (!isMock) {
      let query = supabase
        .from('orders')
        .select('*')
        .eq('status', 'pending_supplier_confirmation')
        .eq('supplier_id', supplier.id)
        .eq('client_id', clientId)
        .order('created_at', { ascending: true })
        .limit(1);
      const { data, error } = await query;

      if (error) {
        console.error('Error fetching awaiting-supplier order from Supabase:', error);
        return null;
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      return data.orders
        .filter(o => o.status === 'pending_supplier_confirmation' && o.supplier_id === supplier.id && o.client_id === clientId)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0] || null;
    }
  },

  /**
   * Fetch ALL orders still awaiting a supplier's confirmation, across every
   * tenant. Powers the supplier-response-timeout cron (nudge/escalation).
   * When clientId is provided it scopes the scan to a single tenant.
   */
  async getAwaitingSupplierOrders(clientId = null) {
    if (!isMock) {
      let query = supabase
        .from('orders')
        .select('*')
        .eq('status', 'pending_supplier_confirmation')
        .order('created_at', { ascending: true });
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query;
      if (error) {
        console.error('Error fetching awaiting-supplier orders from Supabase:', error);
        return [];
      }
      return data || [];
    } else {
      const data = readMockDb();
      return data.orders
        .filter(o => o.status === 'pending_supplier_confirmation' && (!clientId || o.client_id === clientId))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }
  },

  /**
   * Ops-reply anchor (mirror of getAwaitingSupplierOrder): return the OLDEST
   * order in 'pending_ops_confirmation' for this tenant when `phone` is the
   * tenant's own operations_contact_phone. Anything else returns null, which
   * lets the disambiguator fall through (the reply is not an ops reply).
   */
  async getAwaitingOpsOrder(phone, clientId = null) {
    if (!phone || !clientId) return null;
    const client = await this.getClientById(clientId);
    if (!client) return null;
    const clean = (num) => String(num || '').replace(/\D/g, '');
    if (clean(client.operations_contact_phone) !== clean(phone)) return null;

    if (!isMock) {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('status', 'pending_ops_confirmation')
        .eq('client_id', clientId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (error) {
        console.error('Error fetching awaiting-ops order from Supabase:', error);
        return null;
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      return data.orders
        .filter(o => o.status === 'pending_ops_confirmation' && o.client_id === clientId)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0] || null;
    }
  },

  /**
   * Fetch a single supplier row by id. When clientId is provided it acts as
   * a tenant guard on the lookup.
   */
  async getSupplierById(supplierId, clientId = null) {
    if (!supplierId) return null;
    if (!isMock) {
      let query = supabase.from('suppliers').select('*').eq('id', supplierId);
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query.maybeSingle();
      if (error) {
        console.error('Error fetching supplier by id from Supabase:', error);
        return null;
      }
      return data || null;
    } else {
      const data = readMockDb();
      return (data.suppliers || []).find(s => s.id === supplierId && (!clientId || s.client_id === clientId)) || null;
    }
  },

  /**
   * Fetch a single order row by id.
   * When clientId is provided it acts as a tenant guard on the lookup.
   */
  async getOrderById(orderId, clientId = null) {
    if (!orderId) return null;

    if (!isMock) {
      let query = supabase.from('orders').select('*').eq('id', orderId);
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query.maybeSingle();

      if (error) {
        console.error('Error fetching order by id from Supabase:', error);
        return null;
      }
      return data;
    } else {
      const data = readMockDb();
      return data.orders.find(o => o.id === orderId && (!clientId || o.client_id === clientId)) || null;
    }
  },

  /**
   * Fetch the line items of an order, each decorated with its product name
   * and computed line total. order_items have no client_id of their own; they
   * are scoped through the parent order (id-keyed). When clientId is provided
   * the Supabase path filters via the embedded orders relationship.
   */
  async getOrderItems(orderId, clientId = null) {
    if (!orderId) return [];

    if (!isMock) {
      let query = supabase
        .from('order_items')
        .select('id, quantity, unit_price, products ( name )')
        .eq('order_id', orderId);
      if (clientId) {
        // Tenant guard through the parent order row.
        query = query.select('id, quantity, unit_price, products ( name ), orders!inner ( client_id )')
          .eq('order_id', orderId)
          .eq('orders.client_id', clientId);
      }
      const { data, error } = await query;

      if (error) {
        console.error('Error fetching order items from Supabase:', error);
        return [];
      }
      return (data || []).map(row => ({
        id: row.id,
        product_name: row.products ? row.products.name : 'Unknown',
        quantity: row.quantity,
        unit_price: row.unit_price,
        item_total: parseFloat((row.quantity * row.unit_price).toFixed(2))
      }));
    } else {
      const data = readMockDb();
      const order = data.orders.find(o => o.id === orderId);
      if (!order || (clientId && order.client_id !== clientId)) return [];
      return data.order_items
        .filter(i => i.order_id === orderId)
        .map(item => {
          const product = data.products.find(p => p.id === item.product_id);
          return {
            id: item.id,
            product_name: product ? product.name : 'Unknown',
            quantity: item.quantity,
            unit_price: item.unit_price,
            item_total: parseFloat((item.quantity * item.unit_price).toFixed(2))
          };
        });
    }
  },

  /**
   * Orders eligible for a credit-reminder: unpaid (payment_status='pending'),
   * in an active (non-rejected/non-cancelled) status, with a credit term set
   * and a customer phone to send the reminder to.
   * When clientId is provided, only that tenant's orders are returned.
   */
  async getPendingOrdersWithTerms(clientId = null) {
    if (!isMock) {
      let query = supabase
        .from('orders')
        .select('*')
        .in('status', ['approved', 'pending_ops_confirmation', 'supplier_confirmed', 'in_progress', 'ready_for_customer'])
        .eq('payment_status', 'pending')
        .not('payment_terms', 'is', null)
        .not('customer_phone', 'is', null);
      if (clientId) query = query.eq('client_id', clientId);
      query = query.order('created_at', { ascending: true });

      const { data, error } = await query;

      if (error) {
        console.error('Error fetching reminder-eligible orders from Supabase:', error);
        return [];
      }
      return data || [];
    } else {
      const data = readMockDb();
      return data.orders
        .filter(o =>
          (!clientId || o.client_id === clientId) &&
          (o.status === 'approved' || o.status === 'pending_ops_confirmation' || o.status === 'supplier_confirmed' || o.status === 'in_progress' || o.status === 'ready_for_customer') &&
          o.payment_status === 'pending' &&
          o.payment_terms &&
          o.customer_phone
        )
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }
  },

  /**
   * Mark an order as having had its credit reminder sent (now).
   * This is the dedup guard for the daily reminder job.
   * When clientId is provided it acts as a tenant guard on the update.
   */
  async markOrderReminded(orderId, clientId = null) {
    if (!isMock) {
      let query = supabase.from('orders').update({ last_reminder_sent_at: new Date().toISOString() }).eq('id', orderId);
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query.select();

      if (error) {
        throw new Error(`Failed to mark order reminded in Supabase: ${error.message}`);
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      const order = data.orders.find(o => o.id === orderId && (!clientId || o.client_id === clientId));
      if (!order) return null;
      order.last_reminder_sent_at = new Date().toISOString();
      writeMockDb(data);
      return order;
    }
  },

  /**
   * Mark an order as having had its supplier nudged (now).
   * Dedup guard for the supplier-response-timeout nudge (1x window).
   */
  async markSupplierNudged(orderId, clientId = null) {
    if (!isMock) {
      let query = supabase.from('orders').update({ supplier_nudged_at: new Date().toISOString() }).eq('id', orderId);
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query.select();
      if (error) {
        throw new Error(`Failed to mark supplier nudged in Supabase: ${error.message}`);
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      const order = data.orders.find(o => o.id === orderId && (!clientId || o.client_id === clientId));
      if (!order) return null;
      order.supplier_nudged_at = new Date().toISOString();
      writeMockDb(data);
      return order;
    }
  },

  /**
   * Mark an order as having been escalated to the seller (now).
   * Dedup guard for the supplier-response-timeout escalation (2x window).
   */
  async markSupplierEscalated(orderId, clientId = null) {
    if (!isMock) {
      let query = supabase.from('orders').update({ supplier_escalated_at: new Date().toISOString() }).eq('id', orderId);
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query.select();
      if (error) {
        throw new Error(`Failed to mark supplier escalated in Supabase: ${error.message}`);
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      const order = data.orders.find(o => o.id === orderId && (!clientId || o.client_id === clientId));
      if (!order) return null;
      order.supplier_escalated_at = new Date().toISOString();
      writeMockDb(data);
      return order;
    }
  },

  /**
   * Look up a conversation by customer phone.
   * Returns the stored row, or an idle default if none exists.
   * (Read-only — does NOT create a row just for a lookup.)
   */
  async getConversationState(customerPhone) {
    if (!customerPhone) {
      return { state: 'idle', pending_order_data: null };
    }

    if (!isMock) {
      const { data, error } = await supabase
        .from('conversations')
        .select('*')
        .eq('customer_phone', customerPhone)
        .maybeSingle();

      if (error) {
        console.error('Error fetching conversation from Supabase:', error);
        return { state: 'idle', pending_order_data: null };
      }
      return data || { state: 'idle', pending_order_data: null };
    } else {
      const data = readMockDb();
      const conversations = data.conversations || [];
      return conversations.find(c => c.customer_phone === customerPhone) || { state: 'idle', pending_order_data: null };
    }
  },

  /**
   * Upsert a conversation's state for a customer phone.
   * Creates the row if it doesn't exist, otherwise updates state,
   * pending_order_data and updated_at.
   */
  async setConversationState(customerPhone, state, pendingOrderData = null) {
    if (!customerPhone) {
      throw new Error('customerPhone is required to set conversation state.');
    }

    const updatedAt = new Date().toISOString();

    if (!isMock) {
      const { data, error } = await supabase
        .from('conversations')
        .upsert({
          customer_phone: customerPhone,
          state,
          pending_order_data: pendingOrderData,
          updated_at: updatedAt
        }, { onConflict: 'customer_phone' })
        .select()
        .single();

      if (error) {
        console.error('Error upserting conversation in Supabase:', error);
        throw new Error(`Failed to set conversation state: ${error.message}`);
      }
      return data;
    } else {
      const data = readMockDb();
      data.conversations = data.conversations || [];
      let conv = data.conversations.find(c => c.customer_phone === customerPhone);
      if (conv) {
        conv.state = state;
        conv.pending_order_data = pendingOrderData;
        conv.updated_at = updatedAt;
      } else {
        conv = {
          id: `conv-${Math.random().toString(36).substr(2, 9)}`,
          customer_phone: customerPhone,
          state,
          pending_order_data: pendingOrderData,
          updated_at: updatedAt
        };
        data.conversations.push(conv);
      }
      writeMockDb(data);
      return conv;
    }
  },

  /**
   * Reset a conversation back to idle with no pending order (upsert).
   */
  async clearConversationState(customerPhone) {
    return this.setConversationState(customerPhone, 'idle', null);
  },

  /**
   * Create multiple order items
   */
  async createOrderItems(items) {
    if (!isMock) {
      const { data, error } = await supabase
        .from('order_items')
        .insert(items)
        .select();

      if (error) {
        throw new Error(`Failed to insert order items in Supabase: ${error.message}`);
      }
      return data;
    } else {
      const data = readMockDb();
      const createdItems = items.map(item => ({
        id: `item-${Math.random().toString(36).substr(2, 9)}`,
        order_id: item.order_id,
        product_id: item.product_id,
        quantity: parseInt(item.quantity),
        unit_price: parseFloat(item.unit_price),
        created_at: new Date().toISOString()
      }));

      data.order_items.push(...createdItems);
      writeMockDb(data);
      return createdItems;
    }
  },

  /**
   * Update product stock levels and supplier balance (Transaction/Sequential Updates)
   * Scoped to a client: supplier/product rows are only touched when they belong
   * to clientId.
   */
  async updateStockAndBalance({ items, supplier_id, balance_adjustment }, clientId = null) {
    if (!isMock) {
      // 1. Update Supplier Balance
      const { data: supplier, error: balanceError } = await supabase
        .rpc('increment_supplier_balance', { 
          sup_id: supplier_id, 
          amount: balance_adjustment 
        });

      // Standard fallback if custom function rpc is not present:
      if (balanceError) {
        // Fetch current balance first to be accurate, then update
        let balQuery = supabase
          .from('suppliers')
          .select('outstanding_balance')
          .eq('id', supplier_id);
        if (clientId) balQuery = balQuery.eq('client_id', clientId);
        const { data: currentSup } = await balQuery.single();
        
        if (currentSup) {
          const newBalance = parseFloat(currentSup.outstanding_balance) + parseFloat(balance_adjustment);
          let updQuery = supabase
            .from('suppliers')
            .update({ outstanding_balance: newBalance })
            .eq('id', supplier_id);
          if (clientId) updQuery = updQuery.eq('client_id', clientId);
          await updQuery;
        }
      }

      // 2. Update Product Stock Levels sequentially
      for (const item of items) {
        let prodQuery = supabase
          .from('products')
          .select('stock_quantity')
          .eq('id', item.product_id);
        if (clientId) prodQuery = prodQuery.eq('client_id', clientId);
        const { data: currentProd } = await prodQuery.single();
        
        if (currentProd) {
          const newStock = currentProd.stock_quantity - item.quantity;
          let stockQuery = supabase
            .from('products')
            .update({ stock_quantity: newStock })
            .eq('id', item.product_id);
          if (clientId) stockQuery = stockQuery.eq('client_id', clientId);
          await stockQuery;
        }
      }
    } else {
      // Local Mock DB updates
      const data = readMockDb();
      
      // Update Supplier Balance
      const supplier = data.suppliers.find(s => s.id === supplier_id && (!clientId || s.client_id === clientId));
      if (supplier) {
        supplier.outstanding_balance = parseFloat((parseFloat(supplier.outstanding_balance) + parseFloat(balance_adjustment)).toFixed(2));
      }

      // Update Stock Levels
      for (const item of items) {
        const product = data.products.find(p => p.id === item.product_id && (!clientId || p.client_id === clientId));
        if (product) {
          product.stock_quantity = product.stock_quantity - item.quantity;
        }
      }

      writeMockDb(data);
    }
  },

  /**
   * Fetch all orders from the database, sorted by creation date descending.
   * If real Supabase is used, joins with the suppliers table to include the supplier's name.
   * When clientId is provided, only that tenant's orders are returned.
   */
  async getAllOrders(clientId = null) {
    if (!isMock) {
      let query = supabase
        .from('orders')
        .select(`
          id,
          supplier_id,
          status,
          status_reason,
          total_amount,
          payment_status,
          created_at,
          suppliers (
            name
          )
        `);
      if (clientId) query = query.eq('client_id', clientId);
      query = query.order('created_at', { ascending: false });

      const { data, error } = await query;

      if (error) {
        console.error('Error fetching orders from Supabase:', error);
        return [];
      }
      
      // Format to align with dashboard needs
      return data.map(order => ({
        ...order,
        supplier_name: order.suppliers ? order.suppliers.name : 'Unknown'
      }));
    } else {
      const data = readMockDb();
      return data.orders
        .filter(o => !clientId || o.client_id === clientId)
        .map(order => {
          const supplier = data.suppliers.find(s => s.id === order.supplier_id);
          return {
            ...order,
            supplier_name: supplier ? supplier.name : 'Unknown'
          };
        }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
  },

  /**
   * Fetch all suppliers from the database, sorted alphabetically by name.
   * When clientId is provided, only that tenant's suppliers are returned.
   */
  async getAllSuppliers(clientId = null) {
    if (!isMock) {
      let query = supabase.from('suppliers').select('*');
      if (clientId) query = query.eq('client_id', clientId);
      query = query.order('name', { ascending: true });

      const { data, error } = await query;

      if (error) {
        console.error('Error fetching suppliers from Supabase:', error);
        return [];
      }
      return data;
    } else {
      const data = readMockDb();
      // Ensure all mock suppliers have the default boolean set
      return data.suppliers
        .filter(s => !clientId || s.client_id === clientId)
        .map(s => ({
          ...s,
          can_request_credit: s.can_request_credit !== undefined ? s.can_request_credit : true
        })).sort((a, b) => a.name.localeCompare(b.name));
    }
  },

  /**
   * Update a supplier's credit toggle status (can_request_credit).
   * When clientId is provided it acts as a tenant guard on the update.
   */
  async toggleSupplierCredit(id, canRequestCredit, clientId = null) {
    if (!isMock) {
      let query = supabase
        .from('suppliers')
        .update({ can_request_credit: !!canRequestCredit })
        .eq('id', id);
      if (clientId) query = query.eq('client_id', clientId);
      const { data, error } = await query.select();

      if (error) {
        console.error('Error toggling supplier credit in Supabase:', error);
        throw new Error(`Failed to update supplier credit status: ${error.message}`);
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      const supplier = data.suppliers.find(s => s.id === id && (!clientId || s.client_id === clientId));
      if (supplier) {
        supplier.can_request_credit = !!canRequestCredit;
        writeMockDb(data);
        return supplier;
      }
      return null;
    }
  },

  /**
   * Create a new client (tenant) row. Used by scripts/onboardClient.js to
   * onboard a second business. whatsapp_number is stored digits-only (the
   * lookup normalizes both sides, so a '+' prefix also matches).
   */
  async createClient({ business_name, whatsapp_number, business_category = 'b2b', operations_contact_phone = null, kitchen_contact_phone = null, settlement_account_number = null, settlement_bank_code = null, settlement_email = null, monnify_subaccount_code = null, daily_summary_time = '09:00' }) {
    if (!business_name) throw new Error('createClient requires business_name.');
    if (!whatsapp_number) throw new Error('createClient requires whatsapp_number.');
    const whatsappNumber = String(whatsapp_number).replace(/\D/g, '');

    if (!isMock) {
      const { data, error } = await supabase
        .from('clients')
        .insert([{
          business_name,
          whatsapp_number: whatsappNumber,
          business_category,
          operations_contact_phone: operations_contact_phone || null,
          kitchen_contact_phone: kitchen_contact_phone || null,
          settlement_account_number,
          settlement_bank_code,
          settlement_email,
          monnify_subaccount_code,
          daily_summary_time
        }])
        .select();

      if (error) {
        throw new Error(`Failed to create client in Supabase: ${error.message}`);
      }
      return data[0];
    } else {
      const data = readMockDb();
      const clients = data.clients || [];
      let id = `cli-${String(clients.length + 1).padStart(3, '0')}`;
      while (clients.some(c => c.id === id)) {
        const n = Number(id.replace('cli-', '')) + 1;
        id = `cli-${String(n).padStart(3, '0')}`;
      }
      const client = {
        id,
        business_name,
        whatsapp_number: whatsappNumber,
        business_category,
        operations_contact_phone: operations_contact_phone || null,
        kitchen_contact_phone: kitchen_contact_phone || null,
        settlement_account_number,
        settlement_bank_code,
        settlement_email,
        monnify_subaccount_code,
        daily_summary_time,
        created_at: new Date().toISOString()
      };
      clients.push(client);
      data.clients = clients;
      writeMockDb(data);
      return client;
    }
  },

  /**
   * Capture an early-access lead from the Relay landing page (POST /api/leads).
   * Internal-only marketing data, written with the service_role key.
   * whatsapp_number is stored digits-only, mirroring createClient.
   */
  async createLead({ business_name, whatsapp_number, business_category = 'b2b', email }) {
    if (!business_name) throw new Error('createLead requires business_name.');
    if (!whatsapp_number) throw new Error('createLead requires whatsapp_number.');
    const whatsappNumber = String(whatsapp_number).replace(/\D/g, '');

    if (!isMock) {
      const { data, error } = await supabase
        .from('leads')
        .insert([{
          business_name,
          whatsapp_number: whatsappNumber,
          business_category,
          email
        }])
        .select();

      if (error) {
        throw new Error(`Failed to create lead in Supabase: ${error.message}`);
      }
      return data[0];
    } else {
      const data = readMockDb();
      const leads = data.leads || [];
      let id = `lead-${String(leads.length + 1).padStart(3, '0')}`;
      while (leads.some(l => l.id === id)) {
        const n = Number(id.replace('lead-', '')) + 1;
        id = `lead-${String(n).padStart(3, '0')}`;
      }
      const lead = {
        id,
        business_name,
        whatsapp_number: whatsappNumber,
        business_category,
        email,
        created_at: new Date().toISOString()
      };
      leads.push(lead);
      data.leads = leads;
      writeMockDb(data);
      return lead;
    }
  },

  /**
   * Resolve the id of the per-client "Unknown Supplier" audit placeholder.
   * Every tenant gets its own placeholder row (created at onboarding via
   * createPlaceholderSupplier) so rejected orders stay scoped to that tenant.
   * Falls back to the fixed UNKNOWN_SUPPLIER_ID (the seeded/default client's
   * row) when no tenant is given or the row has not been created yet.
   */
  async getPlaceholderSupplierId(clientId = null) {
    if (!clientId) return UNKNOWN_SUPPLIER_ID;
    const existing = await this.getSupplierByName('Unknown Supplier', clientId);
    return existing ? existing.id : UNKNOWN_SUPPLIER_ID;
  },

  /**
   * Create the "empty starting catalog" for a client: the per-client
   * "Unknown Supplier" audit placeholder row (no real suppliers/products).
   * Idempotent — if the client already has a placeholder it returns it.
   * Reuses the fixed UNKNOWN_SUPPLIER_ID when that id is still free so the
   * seeded/default client keeps its canonical id; otherwise mints a fresh id.
   */
  async createPlaceholderSupplier(clientId) {
    if (!clientId) throw new Error('createPlaceholderSupplier requires clientId.');
    const existing = await this.getSupplierByName('Unknown Supplier', clientId);
    if (existing) return existing;

    if (!isMock) {
      const { data: takenData, error: takenError } = await supabase
        .from('suppliers')
        .select('id')
        .eq('id', UNKNOWN_SUPPLIER_ID);
      if (takenError) {
        throw new Error(`Failed to check placeholder supplier id usage: ${takenError.message}`);
      }
      const id = takenData && takenData.length > 0 ? crypto.randomUUID() : UNKNOWN_SUPPLIER_ID;
      const { data, error } = await supabase
        .from('suppliers')
        .insert([{
          id,
          client_id: clientId,
          name: 'Unknown Supplier',
          contact_email: 'unknown@tea-pipeline.internal',
          contact_phone: null,
          credit_limit: 0.00,
          outstanding_balance: 0.00,
          can_request_credit: false
        }])
        .select();

      if (error) {
        throw new Error(`Failed to create placeholder supplier in Supabase: ${error.message}`);
      }
      return data[0];
    } else {
      const data = readMockDb();
      const taken = (data.suppliers || []).some(s => s.id === UNKNOWN_SUPPLIER_ID);
      const supplier = {
        id: taken ? `ph-unknown-${Math.random().toString(36).substr(2, 8)}` : UNKNOWN_SUPPLIER_ID,
        client_id: clientId,
        name: 'Unknown Supplier',
        contact_email: 'unknown@tea-pipeline.internal',
        contact_phone: null,
        credit_limit: 0.00,
        outstanding_balance: 0.00,
        can_request_credit: false,
        created_at: new Date().toISOString()
      };
      data.suppliers.push(supplier);
      writeMockDb(data);
      return supplier;
    }
  },

  /**
   * Return the first (oldest) client row. Used as a tenant default for legacy
   * direct-API / dev-dashboard paths that carry no webhook-resolved tenant.
   * Single-tenant by construction; a multi-tenant deployment must resolve the
   * client from the webhook business number instead.
   */
  async getDefaultClient() {
    if (!isMock) {
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(1);

      if (error) {
        console.error('Error fetching default client from Supabase:', error);
        return null;
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      const clients = [...(data.clients || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      return clients.length ? clients[0] : null;
    }
  },

  /**
   * Daily order summary for a client over [dayStart, dayEnd): total orders,
   * booked revenue (statuses that aren't rejected/cancelled), unpaid order
   * count, and the best-selling item by units sold (ties broken by name).
   * Both datastores follow the same two-query + JS aggregation so the mock
   * output is byte-for-byte identical to Supabase.
   */
  async getDailySummary(clientId, dayStart, dayEnd) {
    const activeStatuses = [
      'pending',
      'approved',
      'pending_ops_confirmation',
      'pending_supplier_confirmation',
      'supplier_confirmed',
      'supplier_declined',
      'ops_declined',
      'in_progress',
      'ready_for_customer'
    ];

    let orders = [];
    let items = [];
    let products = [];

    if (!isMock) {
      const oq = supabase
        .from('orders')
        .select('*')
        .eq('client_id', clientId)
        .in('status', activeStatuses)
        .gte('created_at', dayStart.toISOString())
        .lt('created_at', dayEnd.toISOString());
      const { data: ordersData, error: ordersError } = await oq;
      if (ordersError) throw new Error(`Failed to fetch orders in Supabase: ${ordersError.message}`);
      orders = ordersData || [];

      if (orders.length) {
        const orderIds = orders.map(o => o.id);
        const { data: itemsData, error: itemsError } = await supabase
          .from('order_items')
          .select('*')
          .in('order_id', orderIds);
        if (itemsError) throw new Error(`Failed to fetch order items in Supabase: ${itemsError.message}`);
        items = itemsData || [];

        const productIds = [...new Set(items.map(i => i.product_id))];
        if (productIds.length) {
          const { data: productsData, error: productsError } = await supabase
            .from('products')
            .select('*')
            .in('id', productIds);
          if (productsError) throw new Error(`Failed to fetch products in Supabase: ${productsError.message}`);
          products = productsData || [];
        }
      }
    } else {
      const data = readMockDb();
      orders = (data.orders || []).filter(o => o.client_id === clientId && activeStatuses.includes(o.status));
      const isoStart = dayStart.toISOString();
      const isoEnd = dayEnd.toISOString();
      orders = orders.filter(o => o.created_at >= isoStart && o.created_at < isoEnd);
      items = (data.order_items || []).filter(i => orders.some(o => o.id === i.order_id));
      products = (data.products || []).filter(p => items.some(i => i.product_id === p.id));
    }

    const totalAmount = o => Number(o.total_amount) || 0;
    const revenue = Number(orders.reduce((sum, o) => sum + totalAmount(o), 0).toFixed(2));
    const unpaidOrders = orders.filter(o => (o.payment_status || 'pending') === 'pending').length;

    const quantityByProduct = {};
    items.forEach(i => {
      quantityByProduct[i.product_id] = (quantityByProduct[i.product_id] || 0) + Number(i.quantity);
    });
    const bestSeller = Object.entries(quantityByProduct)
      .map(([productId, quantity]) => {
        const product = products.find(p => p.id === productId);
        return { name: product ? product.name : null, quantity };
      })
      .sort((a, b) => b.quantity - a.quantity || String(a.name || '').localeCompare(String(b.name || '')))[0] || null;

    return {
      totalOrders: orders.length,
      revenue,
      unpaidOrders,
      bestSeller: bestSeller && bestSeller.name ? bestSeller : null
    };
  },

  /**
   * Clients whose daily summary is due right now: daily_summary_time matches
   * the HH:MM of `now` (falling back to '09:00' for rows seeded before the
   * column existed) and the report for today hasn't been sent yet.
   *
   * TIMEZONE CONVENTION (do not "fix" the filter without reading this):
   * `now.getHours():getMinutes()` reads the runtime's LOCAL clock. Cloudflare
   * Workers isolates run in UTC (no TZ config), so daily_summary_time MUST be
   * stored as the UTC-equivalent of the client's intended local time. For
   * Nigerian/WAT clients (UTC+1, no DST) store intended WAT time minus 1h —
   * e.g. '08:00' to send at 9am WAT. See scripts/onboardClient.js --summary-time.
   */
  async getDueSummaryClients(now = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    const currentTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const today = this.localDateStr(now);

    let clients = [];
    if (!isMock) {
      const { data, error } = await supabase.from('clients').select('*');
      if (error) throw new Error(`Failed to fetch clients in Supabase: ${error.message}`);
      clients = data || [];
    } else {
      clients = readMockDb().clients || [];
    }

    // Per-client minute match (HH:MM is UTC — see timezone note in the JSDoc
    // above) plus once-per-day dedup via last_summary_sent_at.
    return clients.filter(c =>
      (c.daily_summary_time || '09:00') === currentTime &&
      (c.last_summary_sent_at === null || c.last_summary_sent_at === undefined || c.last_summary_sent_at !== today)
    );
  },

  /**
   * Stamp that a client's daily summary has been dispatched today (dedup guard
   * for the every-minute cron).
   */
  async markSummarySent(clientId) {
    if (!isMock) {
      const { error } = await supabase
        .from('clients')
        .update({ last_summary_sent_at: this.localDateStr(new Date()) })
        .eq('id', clientId);
      if (error) throw new Error(`Failed to mark summary sent in Supabase: ${error.message}`);
    } else {
      const data = readMockDb();
      const client = (data.clients || []).find(c => c.id === clientId);
      if (client) {
        client.last_summary_sent_at = this.localDateStr(new Date());
        writeMockDb(data);
      }
    }
  },

  /**
   * Local (server) timezone as YYYY-MM-DD, used for the summary day window and
   * the last_summary_sent_at dedup stamp.
   */
  localDateStr(now = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }
};

module.exports = db;
