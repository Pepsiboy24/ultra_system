/**
 * AI Service
 * 
 * Interacts with the LLM layer to parse conversational text inputs
 * into structured JSON order models.
 */

const cloudflareClient = require('../config/cloudflare');

// Category-specific prompt builders. Each module mirrors the generic prompt
// shape (CATEGORY + buildPrompt(message)). Missing/unrecognized categories
// fall back to the generic prompt inside cloudflareClient (buildPrompt=null).
const PROMPT_MODULES = {
  dropshipper: require('../config/prompts/dropshipperPrompts'),
  restaurant: require('../config/prompts/restaurantPrompts'),
  b2b: require('../config/prompts/b2bPrompts')
};

// Placeholder strings an LLM may echo back verbatim from its extraction
// instructions instead of returning null when no supplier is mentioned.
const PLACEHOLDER_SUPPLIER_NAMES = [
  'supplier/customer name',
  'supplier name',
  'customer name',
  'standard tea name'
];

/**
 * Defensive sanitization: turn an obviously-placeholder supplier_name into
 * null BEFORE it reaches orderService, so a placeholder string is never used
 * as a real search term (which would trigger a bogus unknown-supplier path).
 * @param {unknown} name
 * @returns {string|null}
 */
function normalizeSupplierName(name) {
  if (name === null || name === undefined) return null;
  if (typeof name !== 'string') return String(name);
  const trimmed = name.trim();
  if (trimmed === '') return null;
  const lower = trimmed.toLowerCase();
  if (lower === 'null' || PLACEHOLDER_SUPPLIER_NAMES.includes(lower)) return null;
  return trimmed;
}

/**
 * Apply supplier-name sanitization to any parsed order object.
 */
function sanitizeParsedOrder(parsed) {
  if (parsed && typeof parsed === 'object') {
    parsed.supplier_name = normalizeSupplierName(parsed.supplier_name);
  }
  return parsed;
}

/**
 * Parse an incoming B2B order text message (e.g. from WhatsApp)
 * @param {string} message - Conversational text input
 * @param {string} [businessCategory] - 'dropshipper' | 'restaurant' | 'b2b'.
 *   Unknown/missing categories use the generic fallback prompt.
 * @returns {Promise<Object>} - Parsed order (shape varies by category)
 */
async function parseOrderMessage(message, businessCategory) {
  if (!message || typeof message !== 'string') {
    throw new Error('Invalid message input. Expected a non-empty string.');
  }
  
  const promptModule = PROMPT_MODULES[businessCategory];
  const buildPrompt = promptModule ? promptModule.buildPrompt : null;
  const parsed = await cloudflareClient.parseOrderMessage(message, buildPrompt);
  return sanitizeParsedOrder(parsed);
}

module.exports = {
  parseOrderMessage
};
