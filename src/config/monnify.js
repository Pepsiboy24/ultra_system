/**
 * Monnify Payment Client Setup
 *
 * Configures calls to the Monnify payment gateway (TeamApt):
 *   - POST /api/v1/auth/login  (Basic base64(apiKey:secretKey)) -> bearer access token
 *   - POST /api/v1/sub-accounts (create a per-client settlement sub-account)
 *   - POST /api/v2/merchant/transactions/init-transaction (per-order checkout link)
 *
 * Multi-tenant model (confirmed against Monnify docs): payments are routed to a
 * per-client sub-account via `incomeSplitConfig` (100% to that client's own
 * settlement bank account). Each client (tenant) therefore needs its own
 * sub-account, which is created at onboarding time with the client's settlement
 * bank details (see scripts/onboardClient.js and src/services/paymentService.js).
 *
 * Env:
 *   MONNIFY_API_KEY       - API key (e.g. MK_TEST_xxx) from Monnify dashboard
 *   MONNIFY_SECRET_KEY    - secret key (Basic auth login)
 *   MONNIFY_CONTRACT_CODE - the platform merchant's contract code
 *   MONNIFY_API_URL       - optional override (defaults to sandbox/live)
 *   MONNIFY_LIVE          - set to 1 to target https://api.monnify.com
 *
 * If MONNIFY_* are absent or placeholders, a Mock client simulates sub-account
 * and checkout creation so every order still gets a (clearly fake) payment link
 * and transaction reference during local development and tests.
 */

require('dotenv').config();
const crypto = require('crypto');

const MONNIFY_API_URL =
  process.env.MONNIFY_API_URL ||
  (process.env.MONNIFY_LIVE === '1' ? 'https://api.monnify.com' : 'https://sandbox.monnify.com');

function isMonnifyConfigured() {
  const apiKey = process.env.MONNIFY_API_KEY;
  const secretKey = process.env.MONNIFY_SECRET_KEY;
  const contractCode = process.env.MONNIFY_CONTRACT_CODE;
  return Boolean(
    apiKey && apiKey !== 'your-monnify-api-key' && apiKey.trim() !== '' &&
    secretKey && secretKey !== 'your-monnify-secret-key' && secretKey.trim() !== '' &&
    contractCode && contractCode !== 'your-monnify-contract-code' && contractCode.trim() !== ''
  );
}

const isMock = !isMonnifyConfigured();
const contractCode = process.env.MONNIFY_CONTRACT_CODE || null;

if (!isMock) {
  console.log('⚡ Pipeline Monnify: Configured to use live Monnify gateway.');
} else {
  console.log('⚡ Pipeline Monnify: Configured to use mock payment client (no real charges).');
}

// OAuth 2.0 bearer token cache. Monnify access tokens last ~1 hour; we refresh
// lazily (on expiry or on a 401) so we never hold a stale token.
let tokenCache = { accessToken: null, expiresAt: 0 };

/**
 * Fetch a bearer access token via Basic auth, caching it until near expiry.
 * @returns {Promise<string>}
 */
async function getAccessToken() {
  if (isMock) return 'mock-access-token';

  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.accessToken;
  }

  const credentials = Buffer.from(`${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`).toString('base64');

  const res = await fetch(`${MONNIFY_API_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: 'application/json'
    }
  });

  const data = await res.json();

  if (!res.ok || !data.requestSuccessful) {
    throw new Error(`Monnify auth failed (${res.status}): ${JSON.stringify(data)}`);
  }

  tokenCache = {
    accessToken: data.responseBody.accessToken,
    expiresAt: Date.now() + (data.responseBody.expiresIn || 3599) * 1000
  };
  return tokenCache.accessToken;
}

/**
 * Shared request helper: adds the bearer token and retries once on 401 (token
 * may have been revoked mid-session and needs a fresh login).
 */
async function monnifyRequest(path, { method = 'GET', body = null } = {}) {
  const doRequest = async (token) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    const res = await fetch(`${MONNIFY_API_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null
    });
    const data = await res.json();
    return { status: res.status, data };
  };

  let { status, data } = await doRequest(await getAccessToken());

  if (status === 401) {
    // Force a fresh token once, then retry the original request.
    tokenCache = { accessToken: null, expiresAt: 0 };
    ({ status, data } = await doRequest(await getAccessToken()));
  }

  if (status < 200 || status >= 300 || data.requestSuccessful === false) {
    throw new Error(`Monnify API error (${status}) on ${path}: ${JSON.stringify(data)}`);
  }
  return data.responseBody;
}

function mockRef(prefix) {
  return `${prefix}_MOCK_${Math.random().toString(36).substr(2, 10).toUpperCase()}`;
}

/**
 * Verify a Monnify webhook notification signature.
 *
 * Per Monnify's docs, the `monnify-signature` header is the HMAC-SHA512 of the
 * RAW request body, keyed with the merchant's Client Secret Key:
 *     signature = HMAC-SHA512(clientSecret, rawBody)  (hex)
 * The header is only present on production notifications (not sandbox), so a
 * non-mock deployment MUST have the secret configured and MUST present a valid
 * signature; anything else is rejected. Local/dev/tests (mock mode with no
 * secret) are accepted for exercisability only.
 *
 * @param {string} rawBody - the exact, un-parsed request body as received
 * @param {string|null|undefined} signatureHeader - value of `monnify-signature`
 * @returns {{ valid: boolean, reason?: string, mode?: string }}
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.MONNIFY_SECRET_KEY;

  if (!secret || secret === 'your-monnify-secret-key') {
    return isMock
      ? { valid: true, mode: 'mock' }
      : { valid: false, reason: 'missing_secret' };
  }

  if (typeof rawBody !== 'string' || rawBody.length === 0) {
    return { valid: false, reason: 'missing_body' };
  }

  if (!signatureHeader || String(signatureHeader).trim() === '') {
    return { valid: false, reason: 'missing_signature' };
  }

  let provided = String(signatureHeader).trim();
  if (provided.toLowerCase().startsWith('sha512=')) {
    provided = provided.slice('sha512='.length);
  }
  provided = provided.toLowerCase();

  const expected = crypto.createHmac('sha512', secret).update(rawBody, 'utf8').digest('hex');

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length) return { valid: false, reason: 'signature_mismatch' };
  if (!crypto.timingSafeEqual(a, b)) return { valid: false, reason: 'signature_mismatch' };

  return { valid: true };
}

const monnifyClient = {
  isMock,
  contractCode,

  getAccessToken,
  verifyWebhookSignature,

  /**
   * Create a Monnify sub-account (per-client settlement routing). The sub-account
   * is bound to the client's own settlement bank account; payments init'd with an
   * incomeSplitConfig referencing its subAccountCode are settled 100% to that
   * client instead of the platform wallet.
   *
   * @returns {Promise<{ subAccountCode: string, accountNumber?: string, bankName?: string }>}
   */
  async createSubAccount({ accountName, bankCode, accountNumber, email, currencyCode = 'NGN', defaultSplitPercentage = 100 }) {
    if (isMock) {
      return {
        subAccountCode: mockRef('MFY_SUB'),
        accountNumber,
        accountName,
        currencyCode,
        bankCode,
        bankName: 'MOCK BANK',
        email,
        defaultSplitPercentage
      };
    }

    const [subAccount] = await monnifyRequest('/api/v1/sub-accounts', {
      method: 'POST',
      body: [{
        currencyCode,
        accountNumber,
        bankCode,
        email,
        defaultSplitPercentage
      }]
    });

    return subAccount;
  },

  /**
   * Initialize a one-time checkout session and return the hosted payment link.
   * The checkout URL is valid for 40 minutes. `incomeSplitConfig` routes the
   * payment (100%) to the client's own sub-account.
   *
   * @returns {Promise<{ checkoutUrl: string, transactionReference: string, paymentReference: string, contractCode?: string }>}
   */
  async initCheckout({ amount, paymentReference, contractCode: cc, customerName, customerEmail = null, paymentDescription, currencyCode = 'NGN', paymentMethods = ['CARD', 'ACCOUNT_TRANSFER', 'USSD'], incomeSplitConfig = [], redirectUrl }) {
    if (isMock) {
      return {
        transactionReference: mockRef('MFY_TX'),
        paymentReference,
        contractCode: cc || contractCode,
        checkoutUrl: `${MONNIFY_API_URL}/pay/mock-${paymentReference}-${Math.random().toString(36).substr(2, 6)}`
      };
    }

    return monnifyRequest('/api/v2/merchant/transactions/init-transaction', {
      method: 'POST',
      body: {
        amount,
        paymentReference,
        contractCode: cc,
        currencyCode,
        customerName,
        customerEmail,
        paymentDescription,
        paymentMethods,
        incomeSplitConfig,
        redirectUrl
      }
    });
  }
};

module.exports = monnifyClient;