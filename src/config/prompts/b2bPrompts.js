/**
 * B2B business-category extraction prompt.
 *
 * Same shape as the generic prompt in src/config/cloudflare.js
 * (buildGenericPrompt): a system line, an Extract list, the input message,
 * Rules, and an exact "Return JSON" structure.
 *
 * Output shape (differs from dropshipper/restaurant):
 * {
 *   supplier_name: string|null,
 *   items: [{ product_name, quantity, unit }],
 *   delivery_location: string|null,
 *   payment_terms: string|null
 * }
 *
 * The bulk-unit vocabulary (kg, cartons, bags, boxes, ...) is REUSED from
 * src/config/cloudflare.js (CONTAINER_UNIT_WORDS) rather than re-defined
 * here, so the prompt can never drift from the parser's vocabulary.
 */

const { CONTAINER_UNIT_WORDS } = require('../cloudflare');

const CATEGORY = 'b2b';

/**
 * Build the b2b extraction prompt for a given message.
 * @param {string} message
 * @returns {string}
 */
function buildPrompt(message) {
  return `You are a B2B order processing assistant. Your task is to parse an incoming natural language WhatsApp order message from a business buyer and convert it into a structured B2B order JSON.

Extract:
1. The supplier name (the vendor being ordered from).
2. Each ordered item's product name and quantity. Support bulk units: ${CONTAINER_UNIT_WORDS.replace(/\|/g, ', ')}.
3. The delivery location, if mentioned.
4. Credit/payment terms, if mentioned (e.g. "14 days", "net-30", "pay on delivery").

Input Message:
"${message}"

Rules:
- If the message does NOT clearly mention a supplier name, set "supplier_name" to null.
- Strip the bulk-unit word from the product name and record it in "unit" instead (e.g. "10 cartons of pineapple tea" -> product_name "Pineapple Tea", quantity 10, unit "cartons").
- If no delivery location is mentioned, set "delivery_location" to null.
- If no credit/payment terms are mentioned, set "payment_terms" to null.
- Never output placeholder text such as "Supplier/Customer Name" — treat that field as null instead.

Return JSON matching this exact structure, and nothing else:
{
  "supplier_name": null,
  "items": [
    {
      "product_name": "Standard Tea Name",
      "quantity": 10,
      "unit": "cartons"
    }
  ],
  "delivery_location": null,
  "payment_terms": null
}`;
}

module.exports = { CATEGORY, buildPrompt };