/**
 * WhatsApp Outbound Messaging Service
 *
 * Sends messages back to a user via the WhatsApp Cloud API (Graph API).
 * Uses Node's built-in global fetch (Node 18+).
 */

const GRAPH_API_VERSION = 'v25.0';

/**
 * Send a plain text WhatsApp message.
 * @param {string} to - Recipient phone number in international format, no '+' (e.g. "2347026260030")
 * @param {string} body - Message text to send
 * @returns {Promise<Object>} - Parsed JSON response from the Graph API
 */
async function sendTextMessage(to, body) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    console.error('❌ WhatsApp Send Error: Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN in .env');
    return { success: false, error: 'missing_credentials' };
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ WhatsApp Send Failed:', JSON.stringify(data, null, 2));
      return { success: false, error: data };
    }

    console.log(`📤 WhatsApp Reply Sent to ${to}: "${body.slice(0, 80)}${body.length > 80 ? '...' : ''}"`);
    return { success: true, data };
  } catch (err) {
    console.error('❌ WhatsApp Send Exception:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Build a human-readable confirmation/rejection message from a pipeline result.
 * @param {Object} pipelineResult - The result object returned by orderService.processOrderPipeline
 * @returns {string}
 */
function buildOrderReplyMessage(pipelineResult) {
  if (pipelineResult.success) {
    const order = pipelineResult.order;
    const itemLines = (pipelineResult.items || [])
      .map(item => `• ${item.quantity} x ${item.product_name}`)
      .join('\n');

    return (
      `✅ Order confirmed!\n\n` +
      `${itemLines}\n\n` +
      `Total: $${Number(order.total_amount).toFixed(2)}\n` +
      `Order ID: ${order.id}\n` +
      (order.payment_link ? `Pay here: ${order.payment_link}` : '')
    );
  }

  return `❌ Sorry, we couldn't process your order.\n\nReason: ${pipelineResult.reason || 'Unknown error.'}`;
}

module.exports = {
  sendTextMessage,
  buildOrderReplyMessage
};
