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
    // Restaurant prompt returns items as { item_name }, while the pipeline
    // validates on product_name. Normalize so both shapes work.
    if (Array.isArray(parsed.items)) {
      parsed.items = parsed.items.map(i => ({ ...i, product_name: i.product_name || i.item_name }));
    }
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

/**
 * Normalize a (mock or live) menu-matched parse into the canonical term shape
 * restaurantService consumes. Every menu-matching outcome ends in exactly one
 * of three states, mirroring the prompt/mock contract:
 *   - matched   : { term, outcome:'matched', product_id, ... }
 *   - ambiguous : { term, outcome:'ambiguous', candidates:[ids], ... }
 *   - no_match  : { term, outcome:'no_match', suggested_category?, ... }
 *
 * Defensive fallbacks: entries without an "outcome" are inferred from their
 * shape, and ids/quantities are coerced so downstream server-side verification
 * always has clean input.
 *
 * @param {Object} parsed - Raw LLM/mock response
 * @param {Array<Object>} menuItems - Client menu rows ({ id, name, ... })
 * @returns {{ items: Array<Object> }} Canonical term shape (see above)
 */
function normalizeMenuTerms(parsed, menuItems) {
  const rawItems = parsed && Array.isArray(parsed.items) ? parsed.items : [];
  const menu = Array.isArray(menuItems) ? menuItems : [];
  const items = [];

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;

    let quantity = parseInt(raw.quantity, 10);
    if (Number.isNaN(quantity) || quantity < 1) quantity = 1;
    const modifiers = Array.isArray(raw.modifiers)
      ? raw.modifiers.filter(m => typeof m === 'string')
      : [];

    let outcome = String(raw.outcome || '').toLowerCase().trim();
    if (!['matched', 'ambiguous', 'no_match', 'unavailable'].includes(outcome)) {
      outcome = raw.product_id
        ? 'matched'
        : (Array.isArray(raw.candidates) && raw.candidates.length ? 'ambiguous' : 'no_match');
    }

    const candidateIds = Array.isArray(raw.candidates)
      ? raw.candidates
          .map(c => (typeof c === 'string' ? c : (c && c.product_id) || (c && c.id) || null))
          .filter(Boolean)
      : [];

    let term = String(raw.term || raw.item_name || '').trim();
    if (!term) {
      if (outcome === 'matched') {
        const product = menu.find(m => m.id === raw.product_id);
        term = product ? product.name : 'item';
      } else {
        term = 'item';
      }
    }

    items.push({
      term,
      outcome,
      quantity,
      modifiers,
      product_id: raw.product_id || null,
      candidates: candidateIds,
      suggested_category: raw.suggested_category || null
    });
  }

  return { items };
}

/**
 * Parse an incoming restaurant order against the client's actual menu.
 *
 * Menu-based matching (restaurant category only): the FULL menu is passed to
 * the LLM as structured context and the model classifies each item into one of
 * three outcomes — matched / ambiguous / no_match — using EXACT product ids.
 * Downstream (restaurantService) re-verifies every returned id exists in the
 * client's products table and resolves ambiguous/no_match items with the
 * customer instead of silently guessing.
 *
 * @param {string} message - Customer's WhatsApp order text
 * @param {Array<Object>} menuItems - Client menu rows ({ id, name, ... })
 * @returns {Promise<{ items: Array<Object> }>}
 *   items: [{ term, outcome, quantity, modifiers, product_id, candidates, suggested_category }]
 */
async function parseRestaurantMenuOrder(message, menuItems) {
  if (!message || typeof message !== 'string') {
    throw new Error('Invalid message input. Expected a non-empty string.');
  }
  const parsed = await cloudflareClient.parseOrderWithMenu(message, menuItems);
  return normalizeMenuTerms(parsed, menuItems);
}

/**
 * Constrained restaurant question-answering (secondary check, used only when
 * the order parser found no items). Never throws — returns
 * { is_question:false, answer:null } on any problem.
 */
async function answerRestaurantQuestion(message, context) {
  if (!message || typeof message !== 'string') return { is_question: false, answer: null };
  try {
    return await cloudflareClient.answerRestaurantQuestion(message, context);
  } catch (error) {
    console.error(`❌ answerRestaurantQuestion failed: ${error.message}`);
    return { is_question: false, answer: null };
  }
}

module.exports = {
  parseOrderMessage,
  parseRestaurantMenuOrder,
  answerRestaurantQuestion
};
