/**
 * Invoice Controller
 *
 * Exposes Express routing for the hosted HTML invoice page.
 * GET /api/invoices/:orderId renders a self-contained HTML invoice from the
 * order record (generated at order creation — see orderService). Plain HTML
 * with inline CSS; no PDF/rendering library is needed given the app's deps.
 */

const express = require('express');
const router = express.Router();
const db = require('../config/db');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusBadge(order) {
  switch (order.status) {
    case 'approved':
      return '<span class="badge approved">APPROVED</span>';
    case 'pending_ops_confirmation':
      return '<span class="badge pending">PENDING OPS CONFIRMATION</span>';
    case 'pending_supplier_confirmation':
      return '<span class="badge pending">PENDING SUPPLIER CONFIRMATION</span>';
    case 'supplier_confirmed':
      return '<span class="badge approved">SUPPLIER CONFIRMED</span>';
    case 'in_progress':
      return '<span class="badge approved">IN PROGRESS</span>';
    case 'supplier_declined':
      return '<span class="badge rejected">SUPPLIER DECLINED</span>';
    case 'ops_declined':
      return '<span class="badge rejected">OPS DECLINED</span>';
    case 'ready_for_customer':
      return '<span class="badge approved">READY FOR CUSTOMER</span>';
    case 'rejected':
      return '<span class="badge rejected">REJECTED</span>';
    case 'cancelled':
      return '<span class="badge cancelled">CANCELLED</span>';
    default:
      return `<span class="badge pending">${escapeHtml(order.status)}</span>`;
  }
}

/**
 * Render a self-contained HTML invoice for an order.
 * @param {Object} order - Order row (business_name, total_amount, payment_link,
 *                         invoice_url, delivery_location, payment_terms, status,
 *                         created_at)
 * @param {Array} items - Line items ({ product_name, quantity, unit_price, item_total })
 * @returns {string} HTML document
 */
function renderInvoice(order, items) {
  const issueDate = new Date(order.created_at).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric'
  });

  const itemRows = (items || [])
    .map(item => `
      <tr>
        <td>${escapeHtml(item.product_name)}</td>
        <td class="num">${item.quantity}</td>
        <td class="num">₦${Number(item.unit_price).toFixed(2)}</td>
        <td class="num">₦${Number(item.item_total).toFixed(2)}</td>
      </tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice ${escapeHtml(order.id)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         background: #f3f4f6; margin: 0; padding: 24px; color: #111827; }
  .invoice { max-width: 640px; margin: 0 auto; background: #fff; border-radius: 12px;
             padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .head { display: flex; justify-content: space-between; align-items: flex-start;
          border-bottom: 2px solid #e5e7eb; padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .brand { color: #374151; font-weight: 600; }
  .meta { text-align: right; font-size: 13px; color: #6b7280; line-height: 1.6; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px;
           font-size: 11px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; }
  .badge.approved { background: #d1fae5; color: #065f46; }
  .badge.pending  { background: #fef3c7; color: #92400e; }
  .badge.rejected { background: #fee2e2; color: #991b1b; }
  .badge.cancelled{ background: #e5e7eb; color: #374151; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0 24px; font-size: 14px; }
  th { text-align: left; color: #6b7280; font-weight: 600; font-size: 12px;
       text-transform: uppercase; letter-spacing: .04em; padding: 8px; border-bottom: 1px solid #e5e7eb; }
  td { padding: 10px 8px; border-bottom: 1px solid #f3f4f6; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .totals { margin-left: auto; width: 240px; font-size: 14px; }
  .totals .row { display: flex; justify-content: space-between; padding: 4px 0; }
  .totals .grand { font-weight: 800; font-size: 16px; border-top: 2px solid #e5e7eb;
                   margin-top: 4px; padding-top: 8px; }
  .pay { display: block; text-align: center; margin: 24px 0 8px; padding: 14px;
         background: #065f46; color: #fff !important; text-decoration: none;
         border-radius: 8px; font-weight: 700; font-size: 15px; }
  .pay:hover { background: #047857; }
  .note { font-size: 12px; color: #6b7280; text-align: center; }
  .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e7eb;
            font-size: 12px; color: #9ca3af; text-align: center; }
</style>
</head>
<body>
  <div class="invoice">
    <div class="head">
      <div>
        <h1>Invoice</h1>
        <div class="brand">${escapeHtml(order.business_name || '—')}</div>
      </div>
      <div class="meta">
        <div>${statusBadge(order)}</div>
        <div>Inv. #${escapeHtml(order.id)}</div>
        <div>Issued: ${issueDate}</div>
      </div>
    </div>

    <table>
      <thead>
        <tr><th>Item</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Total</th></tr>
      </thead>
      <tbody>
        ${itemRows || '<tr><td colspan="4">No line items.</td></tr>'}
      </tbody>
    </table>

    <div class="totals">
      <div class="row"><span>Delivery</span><span>${escapeHtml(order.delivery_location || '—')}</span></div>
      <div class="row"><span>Payment terms</span><span>${escapeHtml(order.payment_terms || '—')}</span></div>
      <div class="row grand"><span>Total</span><span>₦${Number(order.total_amount).toFixed(2)}</span></div>
    </div>

    ${order.payment_link
      ? `<a class="pay" href="${escapeHtml(order.payment_link)}" target="_blank" rel="noopener">Pay this invoice →</a>
         <div class="note">Payment link valid for this order.</div>`
      : '<div class="note">Payment link not available.</div>'}

    <div class="footer">
      ${escapeHtml(order.business_name || '')} · B2B Tea Pipeline · Invoice rendered at
      ${escapeHtml(order.invoice_url || '')}
    </div>
  </div>
</body>
</html>`;
}

router.get('/:orderId', async (req, res) => {
  try {
    const order = await db.getOrderById(req.params.orderId);
    if (!order) {
      return res.status(404).type('html').send('<h1 style="font-family:sans-serif">404 — Invoice not found.</h1>');
    }
    const items = await db.getOrderItems(order.id);
    res.type('html').send(renderInvoice(order, items));
  } catch (error) {
    console.error('❌ Invoice Render Error:', error);
    res.status(500).type('html').send('<h1 style="font-family:sans-serif">500 — Failed to render invoice.</h1>');
  }
});

module.exports = router;
module.exports.renderInvoice = renderInvoice;