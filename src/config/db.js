/**
 * Unified Database Interface (Repository Pattern)
 * 
 * Automatically switches between a real Supabase client and a local JSON mock database
 * based on whether valid environment variables are defined.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const MOCK_DB_PATH = path.join(__dirname, '../../db/mock_db.json');

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

/**
 * Data Repository API
 */
const db = {
  isMock,

  /**
   * Look up a supplier by name using case-insensitive partial match
   */
  async getSupplierByName(name) {
    if (!name) return null;
    
    if (!isMock) {
      // Find matching supplier using Supabase ilike
      const { data, error } = await supabase
        .from('suppliers')
        .select('*')
        .ilike('name', `%${name}%`)
        .limit(1);

      if (error) {
        console.error('Error fetching supplier from Supabase:', error);
        return null;
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      // Local mock search
      const data = readMockDb();
      const lowerSearch = name.toLowerCase();
      const found = data.suppliers.find(s => s.name.toLowerCase().includes(lowerSearch));
      return found || null;
    }
  },

  /**
   * Look up a supplier by contact phone
   */
  async getSupplierByPhone(phone) {
    if (!phone) return null;

    if (!isMock) {
      // Find matching supplier by contact_phone in Supabase
      const { data, error } = await supabase
        .from('suppliers')
        .select('*')
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
      const found = data.suppliers.find(s => {
        if (!s.contact_phone) return false;
        const cleanContact = s.contact_phone.replace(/\D/g, '');
        return cleanContact === cleanPhone || s.contact_phone === phone;
      });
      return found || null;
    }
  },


  /**
   * Look up a product by name using case-insensitive partial match
   */
  async getProductByName(name) {
    if (!name) return null;

    if (!isMock) {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .ilike('name', `%${name}%`)
        .limit(1);

      if (error) {
        console.error('Error fetching product from Supabase:', error);
        return null;
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      const lowerSearch = name.toLowerCase();
      const found = data.products.find(p => p.name.toLowerCase().includes(lowerSearch));
      return found || null;
    }
  },

  /**
   * Create a new order record
   */
  async createOrder({ supplier_id, status, status_reason = null, total_amount, payment_status = 'pending', payment_link = null }) {
    if (!isMock) {
      const { data, error } = await supabase
        .from('orders')
        .insert([{
          supplier_id,
          status,
          status_reason,
          total_amount,
          payment_status,
          //payment_link
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
        supplier_id,
        status,
        status_reason,
        total_amount: parseFloat(total_amount),
        payment_status,
        //payment_link,
        created_at: new Date().toISOString()
      };
      
      data.orders.push(newOrder);
      writeMockDb(data);
      return newOrder;
    }
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
   */
  async updateStockAndBalance({ items, supplier_id, balance_adjustment }) {
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
        const { data: currentSup } = await supabase
          .from('suppliers')
          .select('outstanding_balance')
          .eq('id', supplier_id)
          .single();
        
        if (currentSup) {
          const newBalance = parseFloat(currentSup.outstanding_balance) + parseFloat(balance_adjustment);
          await supabase
            .from('suppliers')
            .update({ outstanding_balance: newBalance })
            .eq('id', supplier_id);
        }
      }

      // 2. Update Product Stock Levels sequentially
      for (const item of items) {
        const { data: currentProd } = await supabase
          .from('products')
          .select('stock_quantity')
          .eq('id', item.product_id)
          .single();
        
        if (currentProd) {
          const newStock = currentProd.stock_quantity - item.quantity;
          await supabase
            .from('products')
            .update({ stock_quantity: newStock })
            .eq('id', item.product_id);
        }
      }
    } else {
      // Local Mock DB updates
      const data = readMockDb();
      
      // Update Supplier Balance
      const supplier = data.suppliers.find(s => s.id === supplier_id);
      if (supplier) {
        supplier.outstanding_balance = parseFloat((parseFloat(supplier.outstanding_balance) + parseFloat(balance_adjustment)).toFixed(2));
      }

      // Update Stock Levels
      for (const item of items) {
        const product = data.products.find(p => p.id === item.product_id);
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
   */
  async getAllOrders() {
    if (!isMock) {
      const { data, error } = await supabase
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
        `)
        .order('created_at', { ascending: false });

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
      return data.orders.map(order => {
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
   */
  async getAllSuppliers() {
    if (!isMock) {
      const { data, error } = await supabase
        .from('suppliers')
        .select('*')
        .order('name', { ascending: true });

      if (error) {
        console.error('Error fetching suppliers from Supabase:', error);
        return [];
      }
      return data;
    } else {
      const data = readMockDb();
      // Ensure all mock suppliers have the default boolean set
      return data.suppliers.map(s => ({
        ...s,
        can_request_credit: s.can_request_credit !== undefined ? s.can_request_credit : true
      })).sort((a, b) => a.name.localeCompare(b.name));
    }
  },

  /**
   * Update a supplier's credit toggle status (can_request_credit).
   */
  async toggleSupplierCredit(id, canRequestCredit) {
    if (!isMock) {
      const { data, error } = await supabase
        .from('suppliers')
        .update({ can_request_credit: !!canRequestCredit })
        .eq('id', id)
        .select();

      if (error) {
        console.error('Error toggling supplier credit in Supabase:', error);
        throw new Error(`Failed to update supplier credit status: ${error.message}`);
      }
      return data && data.length > 0 ? data[0] : null;
    } else {
      const data = readMockDb();
      const supplier = data.suppliers.find(s => s.id === id);
      if (supplier) {
        supplier.can_request_credit = !!canRequestCredit;
        writeMockDb(data);
        return supplier;
      }
      return null;
    }
  }
};

module.exports = db;
