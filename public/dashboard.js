/**
 * B2B Tea Pipeline Command Center Dashboard
 * Modern ES Modules Client-Side Script
 */

// ==========================================================================
// Toast Notification Utility
// ==========================================================================
function showToast(title, message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'warning') icon = '⚠️';
  if (type === 'error') icon = '❌';

  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <div class="toast-content">
      <span class="toast-title">${title}</span>
      <span class="toast-message">${message}</span>
    </div>
  `;

  container.appendChild(toast);

  // Automatically remove toast after 4.5 seconds
  setTimeout(() => {
    toast.classList.add('removing');
    toast.addEventListener('transitionend', () => {
      toast.remove();
    });
  }, 4500);
}

// ==========================================================================
// Fetch and Render Dashboard Data
// ==========================================================================
export async function fetchDashboardData() {
  try {
    console.log('🔄 Dashboard: Fetching orders and suppliers concurrently...');
    
    // Concurrent GET requests
    const [ordersRes, suppliersRes] = await Promise.all([
      fetch('/api/dashboard/orders'),
      fetch('/api/dashboard/suppliers')
    ]);

    if (!ordersRes.ok || !suppliersRes.ok) {
      throw new Error('API server returned a failed status code.');
    }

    const orders = await ordersRes.json();
    const suppliers = await suppliersRes.json();

    // Dynamically update System Indicators in Header
    updateSystemMetadata(orders);

    // Render Components
    renderSuppliers(suppliers);
    renderOrders(orders);

  } catch (error) {
    console.error('❌ Dashboard Fetch Error:', error);
    showToast('Connection Error', 'Failed to retrieve real-time ledger data. Please verify Express is active.', 'error');
  }
}

// Update the system configuration metadata badges
function updateSystemMetadata(orders) {
  // If orders payload contains metadata, or we query server status.
  // The Express server / root API contains system configurations.
  // Let's call the root endpoint or fetch metadata.
  fetch('/')
    .then(res => res.json())
    .then(meta => {
      const dbBadgeVal = document.getElementById('db-mode-value');
      const aiBadgeVal = document.getElementById('ai-mode-value');
      
      if (dbBadgeVal && meta.system_configuration) {
        dbBadgeVal.textContent = meta.system_configuration.database_mode === 'LOCAL_MOCK_JSON' 
          ? 'MOCK (JSON)' 
          : 'SUPABASE (Postgres)';
      }
      if (aiBadgeVal && meta.system_configuration) {
        aiBadgeVal.textContent = meta.system_configuration.ai_engine_mode === 'HEURISTIC_MOCK_NLP' 
          ? 'MOCK NLP' 
          : 'LIVE GEMINI';
      }
    })
    .catch(() => {
      // Quiet fallback
      const dbBadgeVal = document.getElementById('db-mode-value');
      if (dbBadgeVal) dbBadgeVal.textContent = 'LOCAL_MOCK';
    });
}

// Render the Supplier credit control panel
function renderSuppliers(suppliers) {
  const container = document.getElementById('suppliers-list');
  const countBadge = document.getElementById('supplier-count');
  
  if (!container) return;
  container.innerHTML = '';
  
  if (countBadge) {
    countBadge.textContent = suppliers.length;
  }

  if (suppliers.length === 0) {
    container.innerHTML = `
      <div class="placeholder-supplier-list">
        <span>No registered suppliers found in directory.</span>
      </div>
    `;
    return;
  }

  suppliers.forEach(supplier => {
    const outstanding = parseFloat(supplier.outstanding_balance || 0);
    const limit = parseFloat(supplier.credit_limit || 0);
    const available = Math.max(0, limit - outstanding);
    const rawRatio = limit > 0 ? (outstanding / limit) : 0;
    const ratioPercentage = Math.min(100, rawRatio * 100).toFixed(0);

    // Color code progress bar
    let progressColorClass = '';
    if (rawRatio >= 0.9) {
      progressColorClass = 'progress-danger';
    } else if (rawRatio >= 0.7) {
      progressColorClass = 'progress-warning';
    }

    const card = document.createElement('div');
    card.className = 'supplier-card';
    card.innerHTML = `
      <div class="supplier-card-header">
        <div class="supplier-info">
          <h3>${escapeHtml(supplier.name)}</h3>
          <div class="supplier-meta">
            <span>📞 ${escapeHtml(supplier.contact_phone || 'N/A')}</span>
            <span>✉️ ${escapeHtml(supplier.contact_email)}</span>
          </div>
        </div>
        
        <!-- iOS Style Switch -->
        <label class="switch-control" title="Toggle Supplier Credit Access">
          <input type="checkbox" 
                 id="toggle-${supplier.id}" 
                 ${supplier.can_request_credit ? 'checked' : ''} 
                 data-id="${supplier.id}"
                 data-name="${supplier.name}">
          <span class="slider-switch"></span>
        </label>
      </div>

      <!-- Credit Limits Dashboard -->
      <div class="credit-metrics">
        <div class="metric-group">
          <span class="metric-label">Outstanding Balance</span>
          <span class="metric-val val-outstanding">$${outstanding.toLocaleString(undefined, {minimumFractionDigits: 2})}</span>
        </div>
        <div class="metric-group" style="text-align: right;">
          <span class="metric-label">Available Credit Limit (of $${limit.toLocaleString()})</span>
          <span class="metric-val val-available">$${available.toLocaleString(undefined, {minimumFractionDigits: 2})}</span>
        </div>
      </div>

      <!-- Credit bar -->
      <div class="credit-progress-bar">
        <div class="credit-progress-fill ${progressColorClass}" style="width: ${ratioPercentage}%"></div>
      </div>
    `;

    container.appendChild(card);

    // Bind event listener to credit switch
    const toggleInput = card.querySelector(`#toggle-${supplier.id}`);
    if (toggleInput) {
      toggleInput.addEventListener('change', async (e) => {
        const supplierId = e.target.getAttribute('data-id');
        const supplierName = e.target.getAttribute('data-name');
        const isChecked = e.target.checked;

        // Disable elements temporarily for asynchronous safety
        e.target.disabled = true;

        const success = await updateSupplierCreditToggle(supplierId, isChecked, supplierName);
        
        // Enable switch
        e.target.disabled = false;
        
        if (!success) {
          // Revert state if failed
          e.target.checked = !isChecked;
        }
      });
    }
  });
}

// PUT Request to toggle the supplier's can_request_credit column
async function updateSupplierCreditToggle(supplierId, canRequestCredit, supplierName) {
  try {
    const response = await fetch(`/api/dashboard/suppliers/${supplierId}/credit-toggle`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ can_request_credit: canRequestCredit })
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Failed to update credit settings.');
    }

    const stateDesc = canRequestCredit ? 'ENABLED (Credit Authorized)' : 'DISABLED (Credit Terminated)';
    const toastType = canRequestCredit ? 'success' : 'warning';
    showToast('Credit Limit Adjusted', `Supplier "${supplierName}" credit toggled to ${stateDesc}.`, toastType);
    
    // Dynamically update outstanding balances / elements without a full page reload by fetching latest data
    await fetchDashboardData();
    return true;

  } catch (err) {
    console.error('❌ Toggle Credit API Error:', err);
    showToast('Update Failed', `Could not update credit status for ${supplierName}. (${err.message})`, 'error');
    return false;
  }
}

// Render Orders lists (Active Queue and Rejections Log)
function renderOrders(orders) {
  const activeBody = document.getElementById('active-orders-list');
  const rejectedBody = document.getElementById('rejected-orders-list');
  
  const activeCountBadge = document.getElementById('active-orders-count');
  const rejectedCountBadge = document.getElementById('rejected-orders-count');

  if (!activeBody || !rejectedBody) return;

  activeBody.innerHTML = '';
  rejectedBody.innerHTML = '';

  const activeOrders = orders.filter(o => o.status !== 'rejected');
  const rejectedOrders = orders.filter(o => o.status === 'rejected');

  if (activeCountBadge) activeCountBadge.textContent = activeOrders.length;
  if (rejectedCountBadge) rejectedCountBadge.textContent = rejectedOrders.length;

  // 1. Render Active Orders Queue
  if (activeOrders.length === 0) {
    activeBody.innerHTML = `
      <tr>
        <td colspan="5" class="placeholder-cell">No active orders in processing pipeline.</td>
      </tr>
    `;
  } else {
    activeOrders.forEach(order => {
      const formattedDate = new Date(order.created_at).toLocaleTimeString() + ' (' + new Date(order.created_at).toLocaleDateString() + ')';
      const orderAmount = parseFloat(order.total_amount || 0);

      // Soft Amber highlight for CREDIT orders (all orders are B2B outstanding balances)
      // We label them as CREDIT badge to draw premium visual attention
      const statusBadge = `<span class="badge badge-pending">CREDIT ORDER</span>`;

      // Check if checkout URL is present
      const payButton = order.payment_link && order.payment_link !== 'MOCK_PENDING'
        ? `<a href="${order.payment_link}" target="_blank" class="pay-link" title="Open B2B Invoice Secure URL">💳 Invoice Link</a>`
        : `<span class="text-muted" style="font-size:0.8rem">Pending checkout</span>`;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="text-mono">${order.id.substring(0, 10)}...</td>
        <td><strong>${escapeHtml(order.supplier_name)}</strong></td>
        <td class="text-mono" style="font-weight:600; color:var(--accent-mint)">$${orderAmount.toFixed(2)}</td>
        <td>${payButton}</td>
        <td class="text-muted">${formattedDate}</td>
      `;
      activeBody.appendChild(tr);
    });
  }

  // 2. Render Rejections Exception Log
  if (rejectedOrders.length === 0) {
    rejectedBody.innerHTML = `
      <tr>
        <td colspan="5" class="placeholder-cell">Transaction exception history is clear.</td>
      </tr>
    `;
  } else {
    rejectedOrders.forEach(order => {
      const formattedDate = new Date(order.created_at).toLocaleTimeString();
      const tr = document.createElement('tr');
      const orderAmount = parseFloat(order.total_amount || 0);
      
      tr.innerHTML = `
        <td class="text-mono">${order.id.substring(0, 10)}...</td>
        <td><strong>${escapeHtml(order.supplier_name)}</strong></td>
        <td class="text-mono">$${orderAmount.toFixed(2)}</td>
        <td>
          <span class="badge badge-rejected" style="margin-right: 0.5rem;">REJECTED</span>
          <span class="text-red" style="font-size:0.8rem; font-weight:500;">${escapeHtml(order.status_reason || 'Exception occurred during processing')}</span>
        </td>
        <td class="text-muted">${formattedDate}</td>
      `;
      rejectedBody.appendChild(tr);
    });
  }
}

// ==========================================================================
// Interactive Pipeline Order Simulator
// ==========================================================================
async function setupSimulator() {
  const form = document.getElementById('simulator-form');
  const resultContainer = document.getElementById('simulation-result');
  const submitButton = document.getElementById('btn-submit-simulation');

  if (!form || !resultContainer) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const messageInput = document.getElementById('simulation-text');
    const messageText = messageInput ? messageInput.value.trim() : '';

    if (!messageText) {
      showToast('Simulation Ignored', 'Please type a valid simulated WhatsApp message before sending.', 'warning');
      return;
    }

    // Set UI loading state
    submitButton.disabled = true;
    submitButton.innerHTML = `<span>Processing NLP Pipeline...</span><div class="loader-spinner" style="margin: 0; width:12px; height:12px;"></div>`;
    resultContainer.classList.remove('hidden');
    resultContainer.innerHTML = `
      <div class="sim-res-header">
        <span>🤖 AI NLP Pipeline Terminal</span>
        <span class="badge badge-pending">Analyzing Text</span>
      </div>
      <div class="sim-log-block">
        <div class="sim-log-entry text-info">> Initializing Gemini LLM NLP extraction context...</div>
        <div class="sim-log-entry">> Parsing natural language tea request details...</div>
      </div>
    `;

    try {
      const response = await fetch('/api/process-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: messageText })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Server error processing transaction.');
      }

      // Format elegant simulation analysis log
      let statusClass = result.success ? 'badge-approved' : 'badge-rejected';
      let statusLabel = result.success ? 'APPROVED' : 'PIPELINE REJECTED';

      const extraction = result.nlp_extraction || {};
      const pipeline = result.pipeline_result || {};

      let logsHtml = `
        <div class="sim-res-header">
          <span>🤖 Pipeline Response: ${escapeHtml(extraction.supplier_name || 'Unknown')}</span>
          <span class="badge ${statusClass}">${statusLabel}</span>
        </div>
        <div class="sim-log-block">
          <div class="sim-log-entry text-info">> 1. Natural Language Processing (NLP) Complete</div>
          <div class="sim-log-entry">> Supplier Identified: "${escapeHtml(extraction.supplier_name || 'None')}"</div>
          <div class="sim-log-entry">> Products Parsed:</div>
      `;

      if (extraction.items && extraction.items.length > 0) {
        extraction.items.forEach(item => {
          logsHtml += `<div class="sim-log-entry" style="padding-left: 15px;">- Product: "${escapeHtml(item.product_name)}", Qty: ${parseInt(item.quantity)}</div>`;
        });
      } else {
        logsHtml += `<div class="sim-log-entry text-amber" style="padding-left: 15px;">⚠️ No products parsed from speech.</div>`;
      }

      logsHtml += `
          <div class="sim-log-entry text-info">> 2. Real-Time Pipeline Security Logic</div>
      `;

      if (result.success) {
        logsHtml += `
          <div class="sim-log-entry text-green">> SUCCESS: Secure Transaction Authorized.</div>
          <div class="sim-log-entry text-green">> Order record added (ID: ${pipeline.order_id}).</div>
          <div class="sim-log-entry text-green">> Supplier balance adjusted by $${parseFloat(pipeline.total_amount).toFixed(2)}.</div>
          <div class="sim-log-entry text-green">> Payment link created: ${pipeline.payment_link}</div>
        `;
        showToast('Pipeline Approved', `Simulated order parsed and approved! Total: $${parseFloat(pipeline.total_amount).toFixed(2)}`, 'success');
      } else {
        logsHtml += `
          <div class="sim-log-entry text-red">> REJECTED: Security Validation Checked Failed.</div>
          <div class="sim-log-entry text-red">> Reason: "${escapeHtml(pipeline.reason || 'Verification exception occurred.')}"</div>
        `;
        showToast('Order Rejected', `Simulated order rejected: ${pipeline.reason || 'Validation error'}`, 'error');
      }

      logsHtml += `
          <div class="sim-log-entry text-muted">> Processed in local environment mode: ${result.system_metadata.database_mode}</div>
        </div>
      `;

      resultContainer.innerHTML = logsHtml;

      // Refresh Dashboard lists to reflect the transaction results immediately
      await fetchDashboardData();

    } catch (err) {
      console.error('❌ Simulation Error:', err);
      resultContainer.innerHTML = `
        <div class="sim-res-header">
          <span>🤖 Pipeline Error</span>
          <span class="badge badge-rejected">FAILED</span>
        </div>
        <div class="sim-log-block">
          <div class="sim-log-entry text-red">Error executing B2B pipeline processing: ${escapeHtml(err.message)}</div>
        </div>
      `;
      showToast('Simulation Failed', `System failed to run natural language parser. (${err.message})`, 'error');
    } finally {
      // Revert simulation button
      submitButton.disabled = false;
      submitButton.innerHTML = `
        <span>Send To Pipeline</span>
        <svg class="send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
      `;
    }
  });
}

// ==========================================================================
// Helper Utilities
// ==========================================================================
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==========================================================================
// Dashboard Lifecycle Entrypoint
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  console.log('🍵 B2B Tea Pipeline Dashboard App Initialized.');
  
  // 1. Fetch data on load
  fetchDashboardData();

  // 2. Refresh Button event
  const refreshBtn = document.getElementById('btn-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      showToast('Refreshing Ledger', 'Syncing pipeline transactions from database...', 'info');
      await fetchDashboardData();
      refreshBtn.disabled = false;
    });
  }

  // 3. Register the Simulator Form actions
  setupSimulator();
});
