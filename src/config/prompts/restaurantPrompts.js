/**
 * Restaurant business-category extraction prompt.
 *
 * Same shape as the generic prompt in src/config/cloudflare.js
 * (buildGenericPrompt): a system line, an Extract list, the input message,
 * Rules, and an exact "Return JSON" structure.
 *
 * Output shape (differs from dropshipper/b2b):
 * {
 *   order_type: 'dine_in' | 'delivery' | null,
 *   items: [{ item_name, quantity, modifiers: [] }]
 * }
 */

const CATEGORY = 'restaurant';

/**
 * Build the restaurant extraction prompt for a given message.
 * @param {string} message
 * @returns {string}
 */
function buildPrompt(message) {
  return `You are an order processing assistant for a restaurant. Your task is to parse an incoming natural language WhatsApp food order and convert it into a structured restaurant order JSON.

Extract:
1. Each ordered item's name and quantity.
2. Any modifiers for each item (e.g. "no onions", "extra spicy").
3. Whether the order is dine-in or delivery, if mentioned.

Input Message:
"${message}"

Rules:
- If no modifiers are mentioned for an item, set "modifiers" to an empty array [].
- If dine-in vs delivery is not mentioned, set "order_type" to null.
- Never output placeholder text such as "Item Name" — infer the real item name from the message.

Return JSON matching this exact structure, and nothing else:
{
  "order_type": null,
  "items": [
    {
      "item_name": "Item Name",
      "quantity": 1,
      "modifiers": []
    }
  ]
}`;
}

/**
 * Build the MENU-BASED restaurant extraction prompt. Unlike buildPrompt, this
 * does NOT ask the model for free-text item names: the client's full menu
 * (id, name, category, price, is_available) is passed as structured context
 * and the model must classify EVERY distinct ordered item into EXACTLY ONE of
 * three outcomes:
 *
 *   - "matched"   : the term corresponds to exactly ONE menu item.
 *   - "ambiguous" : the term could match MULTIPLE menu items.
 *   - "no_match"  : the term matches NO menu item.
 *
 * Every id the model returns (matched or ambiguous candidates) must be a real
 * menu id it was given; ids are still re-verified server-side downstream, and
 * free-text names are never trusted.
 *
 * Output shape:
 * {
 *   "items": [
 *     {
 *       "term": "customer's phrase",
 *       "quantity": 1,
 *       "modifiers": [],
 *       "outcome": "matched" | "ambiguous" | "no_match",
 *       "product_id": "<menu id> | null",        // matched only
 *       "candidates": ["<menu ids>"],             // ambiguous only
 *       "suggested_category": "<category | null>" // no_match only (best guess)
 *     }
 *   ]
 * }
 *
 * @param {Array<Object>} menuItems - Client menu products ({ id, name, category, price, is_available })
 * @param {string} message - The customer's incoming WhatsApp order text
 * @returns {string}
 */
function buildMenuPrompt(menuItems, message) {
  const menuContext = Array.isArray(menuItems)
    ? menuItems.map(m => ({ id: m.id, name: m.name, category: m.category || null, price: m.price, is_available: m.is_available !== false }))
    : [];

  return `You are an order assistant for a restaurant that only KNOWS the exact menu below. Your job is to parse an incoming WhatsApp food order, classifying every distinct item you find into EXACTLY ONE of three outcomes: "matched", "ambiguous", or "no_match".

Restaurant menu (structured context — only these items exist):
${JSON.stringify(menuContext, null, 2)}

Input customer message:
"${message}"

Rules:
- List every distinct ordered item as its own entry in "items". Do not merge different items together.
- For each item set "outcome" to EXACTLY ONE of:
  * "matched": the item corresponds to exactly ONE menu item. Set "product_id" to that menu id. Leave "candidates" as an empty array.
  * "ambiguous": the item could match MORE THAN ONE menu item (e.g. "rice" matching several rice dishes). Set "candidates" to the ids of EVERY menu item the phrase could mean. Leave "product_id" as null.
  * "no_match": the item matches NO menu item. Leave "product_id" null, leave "candidates" empty, and set "suggested_category" to the menu "category" (exactly as written above) the customer most likely meant, or null if none fits.
- "term" is the customer's original phrase for that item (do not paraphrase it).
- All ids in "product_id" and "candidates" MUST be copied exactly from the menu context above — never invent an id or an item.
- "quantity" is the customer's requested quantity, always a positive integer (default 1 if none is given).
- Put any modifiers (e.g. "no onions", "extra spicy") in "modifiers"; empty array if none.
- If the message is NOT an order — a greeting, a question, or a clarification — return "items" as an empty array [].

Return JSON matching this exact structure, and nothing else:
{
  "items": [
    {
      "term": "customer's phrase",
      "quantity": 1,
      "modifiers": [],
      "outcome": "matched",
      "product_id": "ID FROM MENU ABOVE OR null",
      "candidates": [],
      "suggested_category": null
    }
  ]
}`;
}

module.exports = { CATEGORY, buildPrompt, buildMenuPrompt };