/**
 * Cloudflare Workers AI Client Setup
 *
 * Configures calls to the Cloudflare Workers AI run endpoint.
 * If CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are not defined or are
 * placeholders, it returns a Mock AI client that uses regex-based NLP
 * heuristics to simulate order extraction out-of-the-box (same fallback
 * pattern as the previous mistral.js).
 */

require('dotenv').config();

const CF_MODEL = '@cf/meta/llama-3.1-8b-instruct';

function cfConfigured() {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  return (
    acct && acct !== 'your-cloudflare-account-id' && acct.trim() !== '' &&
    token && token !== 'your-cloudflare-api-token' && token.trim() !== ''
  );
}

const isMock = !cfConfigured();

if (!isMock) {
  console.log('⚡ Pipeline Cloudflare: Configured to use live Workers AI (Llama 3.1 8B).');
} else {
  console.log('⚡ Pipeline Cloudflare: Configured to use mock AI heuristic parser.');
}

/**
 * Heuristic Natural Language Parser for Mock Mode
 * (Identical to the previous mistral.js implementation — unchanged.)
 */

// Container/quantity words that should be stripped from captured product names
// (also used by the itemRegex so "10 cartons of pineapple tea" -> "pineapple tea").
const CONTAINER_UNIT_WORDS =
  'bags|packs|units|cartons|boxes|cases|crates|sacks|kgs|kg|kilos|kilograms';

/**
 * Strips container/unit words and trailing supplier clutter ("from X") from a
 * captured product name, mirroring how "bags"/"packs"/"units" were handled.
 */
function stripContainerAndClutter(name) {
  let cleaned = name.trim();

  const leadingContainer = new RegExp(`^(?:${CONTAINER_UNIT_WORDS})\\s+(?:of\\s+)?`, 'i');
  const trailingContainer = new RegExp(`\\s+(?:${CONTAINER_UNIT_WORDS})(?:\\s+of)?\\s*$`, 'i');
  const trailingSupplierClause = /\s+from\s+.*$/i;

  let prev;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(leadingContainer, '');
    cleaned = cleaned.replace(trailingContainer, '');
    cleaned = cleaned.replace(trailingSupplierClause, '');
  } while (cleaned !== prev);

  return cleaned.trim();
}

function mockHeuristicParse(message) {
  console.log(`🤖 [Mock AI NLP Engine] Parsing: "${message}"`);

  const text = message.toLowerCase();

  let supplierName = 'Unknown Supplier';
  if (text.includes('golden tea')) {
    supplierName = 'Golden Tea Co.';
  } else if (text.includes('darjeeling')) {
    supplierName = 'Darjeeling Imports';
  } else if (text.includes('matcha supreme')) {
    supplierName = 'Matcha Supreme';
  } else if (text.includes('bob\'s coffee') || text.includes('bobs coffee')) {
    supplierName = 'Bob\'s Coffee House';
  } else {
    const supplierRegex = /(?:this is|i am|from|here is|hi,?\s+this is|hello,?\s+this is)\s+([a-z\s]+?)(?=\.|,|\band\b|\bwe\b|\bneed\b|\bwant\b|\bto\b|$)/i;
    const match = message.match(supplierRegex);
    if (match && match[1]) {
      supplierName = match[1].trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
  }

  const items = [];
  const itemRegex = new RegExp(
    `(\\d+)\\s*(?:(?:${CONTAINER_UNIT_WORDS})\\s+of|(?:${CONTAINER_UNIT_WORDS}))?\\s*([a-z\\s]+?)(?=\\d+|,|\\band\\b|\\bfrom\\b|\\.|$)`,
    'gi'
  );

  let match;
  while ((match = itemRegex.exec(message)) !== null) {
    const qty = parseInt(match[1], 10);
    let rawProdName = match[2].trim();

    rawProdName = rawProdName.replace(/^(and|we|want|need|order|request|to)\s+/i, '');
    rawProdName = rawProdName.replace(/\s+(and|we|want|need|order)\s*$/i, '');
    rawProdName = stripContainerAndClutter(rawProdName);

    let matchedProdName = rawProdName;
    const prodLower = rawProdName.toLowerCase();
    if (prodLower.includes('earl grey')) {
      matchedProdName = 'Earl Grey Blend';
    } else if (prodLower.includes('chamomile')) {
      matchedProdName = 'Chamomile Fields';
    } else if (prodLower.includes('matcha') || prodLower.includes('ceremonial')) {
      matchedProdName = 'Ceremonial Matcha';
    } else if (prodLower.includes('breakfast') || prodLower.includes('english')) {
      matchedProdName = 'English Breakfast';
    } else {
      matchedProdName = rawProdName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    if (matchedProdName && matchedProdName.length > 2 && qty > 0) {
      items.push({ product_name: matchedProdName, quantity: qty });
    }
  }

  return { supplier_name: supplierName, items };
}

/**
 * Default (generic) extraction prompt. Used when no business-category prompt
 * is supplied — kept as the fallback so behavior is unchanged for categories
 * that are missing or unrecognized.
 */
function buildGenericPrompt(message) {
  return `You are a B2B order processing assistant. Your task is to parse an incoming natural language WhatsApp message from a tea supplier/customer and convert it into a structured B2B order JSON.

Extract:
1. The supplier or customer name.
2. The ordered items, matching them as closely as possible to standard tea product names (e.g. 'Earl Grey Blend', 'Chamomile Fields', 'Ceremonial Matcha', 'English Breakfast').

Input Message:
"${message}"

Rules:
- If the message does NOT clearly mention a supplier or customer name, set "supplier_name" to null.
- Never output placeholder text such as "Supplier/Customer Name" — treat that field as null instead.

Return JSON matching this exact structure, and nothing else:
{
  "supplier_name": null,
  "items": [
    {
      "product_name": "Standard Tea Name",
      "quantity": 10
    }
  ]
}`;
}

const cloudflareClient = {
  isMock,
  CONTAINER_UNIT_WORDS,

  /**
   * Parses natural language using Cloudflare Workers AI (Llama 3.1 8B) or Heuristics.
   * @param {string} message - Incoming order text
   * @param {Function|null} [buildPrompt] - Category-specific prompt builder
   *   (message) => promptString. When null/omitted, the generic fallback
   *   prompt (buildGenericPrompt) is used.
   */
  async parseOrderMessage(message, buildPrompt = null) {
    if (!isMock) {
      try {
        const prompt = buildPrompt ? buildPrompt(message) : buildGenericPrompt(message);

        const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${CF_MODEL}`;

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' }
          })
        });

        const data = await response.json();

        if (!response.ok || data.success === false) {
          throw new Error(`Cloudflare Workers AI error: ${JSON.stringify(data)}`);
        }

        // Workers AI returns { result: { response: ... }, success, errors, messages }
        // In JSON mode, `response` may come back as an already-parsed object,
        // OR as a JSON string, depending on model/version — handle both safely.
        const raw = data.result.response;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return parsed;
      } catch (error) {
        console.error('❌ Live Cloudflare Workers AI parsing failed, falling back to heuristics:', error);
        return mockHeuristicParse(message);
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 600));
      return mockHeuristicParse(message);
    }
  }
};

module.exports = cloudflareClient;
