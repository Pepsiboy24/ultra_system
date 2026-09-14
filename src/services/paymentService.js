/**
 * Payment Service — Monnify checkout links scoped to each client's own
 * sub-account.
 *
 * Multi-tenant routing (confirmed against Monnify docs):
 *   - Each client (tenant) owns a Monnify SUB-ACCOUNT bound to its own
 *     settlement bank account. Onboarding collects those bank details
 *     (scripts/onboardClient.js) and stores them on the clients row.
 *   - Every confirmed order gets a one-off hosted checkout link from
 *     init-transaction, with `incomeSplitConfig` routing 100% of the payment
 *     to that client's subAccountCode. So funds settle to the right business,
 *     never into a single shared platform account.
 *   - The order retains the Monnify `transactionReference` (paymentReference =
 *     the order id) for reconciliation/verification later.
 *
 * When MONNIFY_* env vars are placeholder/absent (dev/tests), the monnify
 * client simulates sub-accounts and checkout links so the full flow is
 * exercisable locally without real charges.
 */

const db = require('../config/db');
const monnify = require('../config/monnify');

/**
 * Make sure the client has a Monnify sub-account, creating it from the
 * client's stored settlement profile when missing.
 *
 * @returns {Promise<string|null>} subAccountCode, or null when the client has
 *   no settlement profile (Payment routing cannot be enabled for them) or
 *   Monnify failed to create the sub-account.
 */
async function ensureClientSubaccount(clientId) {
  const client = await db.getClientById(clientId);
  if (!client) return null;

  if (client.monnify_subaccount_code) {
    return client.monnify_subaccount_code;
  }

  const { settlement_account_number, settlement_bank_code, settlement_email } = client;
  if (!settlement_account_number || !settlement_bank_code || !settlement_email) {
    console.warn(`⚠️ Payment: client "${clientId}" has no settlement profile (settlement account/bank/email). No sub-account can be created; payment routing disabled for this tenant until onboarded with payment details.`);
    return null;
  }

  let subAccount;
  try {
    subAccount = await monnify.createSubAccount({
      accountName: client.business_name || 'Tea Pipeline Client',
      bankCode: settlement_bank_code,
      accountNumber: settlement_account_number,
      email: settlement_email
    });
  } catch (error) {
    console.error(`❌ Payment: failed to create Monnify sub-account for client ${clientId}:`, error.message);
    return null;
  }

  const subAccountCode = subAccount && (subAccount.subAccountCode || subAccount.id);
  if (!subAccountCode) {
    console.error(`❌ Payment: Monnify returned no subAccountCode for client ${clientId}.`);
    return null;
  }

  await db.setClientPaymentProfile(clientId, { monnify_subaccount_code: subAccountCode });
  console.log(`✅ Payment: client ${clientId} now has sub-account ${subAccountCode} (payments route 100% here).`);
  return subAccountCode;
}

/**
 * Create a per-order Monnify checkout link routed to the order's client
 * sub-account. Returns null (never throws) when payment routing is unavailable
 * so the order still completes; the caller falls back to a placeholder link.
 *
 * @param {Object} params
 * @param {Object} params.order - the just-created order row (id, invoice_url)
 * @param {string|null} params.clientId
 * @param {number} params.amount
 * @param {string} [params.customerName]
 * @param {string|null} [params.customerEmail]
 * @param {string} [params.paymentDescription]
 * @returns {Promise<{ checkoutUrl: string, transactionReference: string }|null>}
 */
async function createCheckoutForOrder({ order, clientId, amount, customerName = 'Customer', customerEmail = null, paymentDescription = null }) {
  const subaccountCode = await ensureClientSubaccount(clientId);
  if (!subaccountCode) return null;

  const incomeSplitConfig = [{
    subAccountCode: subaccountCode,
    splitPercentage: 100,
    feePercentage: 0,
    feeBearer: true
  }];

  try {
    const result = await monnify.initCheckout({
      amount,
      paymentReference: order.id,
      contractCode: monnify.contractCode,
      customerName,
      customerEmail,
      paymentDescription: paymentDescription || `Payment for tea order ${order.id}`,
      incomeSplitConfig,
      redirectUrl: order.invoice_url || undefined
    });

    if (!result || !result.checkoutUrl) {
      console.error(`❌ Payment: Monnify init-transaction returned no checkoutUrl for order ${order.id}.`);
      return null;
    }

    return {
      checkoutUrl: result.checkoutUrl,
      transactionReference: result.transactionReference
    };
  } catch (error) {
    console.error(`❌ Payment: failed to initialize Monnify checkout for order ${order.id}:`, error.message);
    return null;
  }
}

module.exports = { ensureClientSubaccount, createCheckoutForOrder };