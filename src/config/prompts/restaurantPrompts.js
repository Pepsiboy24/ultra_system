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

/**
 * Build the constrained question-answering prompt for restaurant clients.
 * Fires ONLY after the order parser found zero items. The model may answer
 * strictly from the facts supplied here; anything else must return
 * is_question:false so the caller uses its existing safe fallback.
 *
 * @param {Object} context - { business_name, accepting_orders, offers_delivery,
 *   offers_pickup, menu:[{name,category,price}], recent_order|null }
 * @param {string} message - Customer's WhatsApp text
 * @returns {string}
 */
function buildQAPrompt(context, message) {
  const menuLines = (context.menu || [])
    .map(m => `- ${m.name}${m.category ? ` (${m.category})` : ''}: ₦${Number(m.price).toFixed(2)}`)
    .join('\n') || '(menu unavailable)';

  const ro = context.recent_order;
  const recentOrderBlock = ro
    ? `\nThe customer has a recent order with us:\n` +
      `- Order #${ro.short_id}: ${ro.items}\n` +
      `- Status: ${ro.is_ready ? 'READY' : 'being prepared'}\n` +
      (ro.is_ready ? '' : ro.eta_range ? `- Current estimate: ${ro.eta_range} minutes from now\n` : '')
    : `\nThe customer has no recent order with us right now.\n`;

  return `You are a helpful assistant for "${context.business_name}", a restaurant that takes orders over WhatsApp. The customer just sent a message that did NOT look like a food order. Decide whether you can confidently answer it using ONLY the facts below — never guess or invent anything not listed here.

Known facts (this is ALL you know — nothing else):
- Accepting orders right now: ${context.accepting_orders ? 'yes' : 'no'}
- Offers delivery: ${context.offers_delivery ? 'yes' : 'no'}
- Offers pickup: ${context.offers_pickup ? 'yes' : 'no'}
- Menu (available items only):
${menuLines}
${recentOrderBlock}
Customer's message:
${JSON.stringify(String(message))}

Rules:
- Set "is_question" to true ONLY if the message is a genuine question AND the facts above are enough to answer it confidently (e.g. asking about their own order's status/ETA, asking whether delivery or pickup is offered, asking what's on the menu or the price of a menu item).
- Set "is_question" to false for anything you cannot answer purely from the facts above — including hours of operation, policies, locations, or anything not listed. Do NOT guess, apologize, or make up a plausible-sounding answer in this case; just return false and let the caller handle it.
- Set "is_question" to false if the message looks like it could actually be an order attempt, a greeting, or small talk rather than a real question.
- When true, "answer" must be a short, friendly WhatsApp-appropriate reply (1-3 sentences), built only from the facts above — never invent a time, price, or detail not shown.

Return JSON matching this exact structure, and nothing else:
{
  "is_question": false,
  "answer": null
}`;
}

module.exports = { CATEGORY, buildPrompt, buildMenuPrompt, buildQAPrompt };