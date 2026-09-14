/**
 * Dropshipper business-category extraction prompt.
 *
 * Same shape as the generic prompt in src/config/cloudflare.js
 * (buildGenericPrompt): a system line, an Extract list, the input message,
 * Rules, and an exact "Return JSON" structure.
 *
 * Output shape (differs from restaurant/b2b):
 * {
 *   items: [{ product_name, quantity, variant }]
 * }
 */

const CATEGORY = 'dropshipper';

/**
 * Build the dropshipper extraction prompt for a given message.
 * @param {string} message
 * @returns {string}
 */
function buildPrompt(message) {
  return `You are an order processing assistant for a dropshipping business. Your task is to parse an incoming natural language WhatsApp message from a customer and convert it into a structured dropship order JSON.

Extract:
1. Each ordered product's name and quantity.
2. A variant or color for each product, if mentioned.
3. Match product names as closely as possible to standard product names.

Input Message:
"${message}"

Rules:
- If no variant/color is mentioned for a product, set "variant" to null.
- Never output placeholder text such as "Product Name" — infer the real product name from the message.

Return JSON matching this exact structure, and nothing else:
{
  "items": [
    {
      "product_name": "Standard Product Name",
      "quantity": 1,
      "variant": null
    }
  ]
}`;
}

module.exports = { CATEGORY, buildPrompt };