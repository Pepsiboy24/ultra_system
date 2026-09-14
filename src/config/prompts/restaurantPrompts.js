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

module.exports = { CATEGORY, buildPrompt };