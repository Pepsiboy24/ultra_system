/**
 * AI Service
 * 
 * Interacts with the LLM layer to parse conversational text inputs
 * into structured JSON order models.
 */

const mistralClient = require('../config/mistral');

/**
 * Parse an incoming B2B order text message (e.g. from WhatsApp)
 * @param {string} message - Conversational text input
 * @returns {Promise<{ supplier_name: string, items: Array<{ product_name: string, quantity: number }> }>}
 */
async function parseOrderMessage(message) {
  if (!message || typeof message !== 'string') {
    throw new Error('Invalid message input. Expected a non-empty string.');
  }
  
  return await mistralClient.parseOrderMessage(message);
}

module.exports = {
  parseOrderMessage
};
