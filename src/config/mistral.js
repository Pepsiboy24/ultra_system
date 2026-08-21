/**
 * Mistral AI Client Setup
 * 
 * Configures calls to the Mistral AI Chat Completions API.
 * If the MISTRAL_API_KEY is not defined or is placeholder,
 * it returns a Mock AI client that uses regex-based NLP heuristics
 * to simulate order extraction out-of-the-box.
 */

require('dotenv').config();

const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';
const MISTRAL_MODEL = 'mistral-small-latest';

function isMistralConfigured() {
  const key = process.env.MISTRAL_API_KEY;
  return key && key !== 'your-mistral-api-key' && key.trim() !== '';
}

const isMock = !isMistralConfigured();

if (!isMock) {
  console.log('⚡ Pipeline Mistral: Configured to use live Mistral Small.');
} else {
  console.log('⚡ Pipeline Mistral: Configured to use mock AI heuristic parser.');
}

/**
 * Heuristic Natural Language Parser for Mock Mode
 * Extends capabilities to parse custom scenarios robustly.
 */
function mockHeuristicParse(message) {
  console.log(`🤖 [Mock AI NLP Engine] Parsing: "${message}"`);

  const text = message.toLowerCase();

  // 1. Supplier Extraction Heuristics
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

  // 2. Items Extraction Heuristics
  const items = [];

  const itemRegex = /(\d+)\s*(?:bags\s*of|bags|packs\s*of|packs|units\s*of|units)?\s*([a-z\s]+?)(?=\d+|,|\band\b|\.|$)/gi;

  let match;
  while ((match = itemRegex.exec(message)) !== null) {
    const qty = parseInt(match[1], 10);
    let rawProdName = match[2].trim();

    rawProdName = rawProdName.replace(/^(and|we|want|need|order|request|to)\s+/i, '');
    rawProdName = rawProdName.replace(/\s+(and|we|want|need|order)\s*$/i, '');

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
      items.push({
        product_name: matchedProdName,
        quantity: qty
      });
    }
  }

  return {
    supplier_name: supplierName,
    items: items
  };
}

const mistralClient = {
  isMock,

  /**
   * Parses natural language using Mistral Small or Heuristics
   */
  async parseOrderMessage(message) {
    if (!isMock) {
      try {
        const prompt = `You are a B2B order processing assistant. Your task is to parse an incoming natural language WhatsApp message from a tea supplier/customer and convert it into a structured B2B order JSON.

Extract:
1. The supplier or customer name.
2. The ordered items, matching them as closely as possible to standard tea product names (e.g. 'Earl Grey Blend', 'Chamomile Fields', 'Ceremonial Matcha', 'English Breakfast').

Input Message:
"${message}"

Return JSON matching this exact structure, and nothing else:
{
  "supplier_name": "Supplier/Customer Name",
  "items": [
    {
      "product_name": "Standard Tea Name",
      "quantity": 10
    }
  ]
}`;

        const response = await fetch(MISTRAL_API_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: MISTRAL_MODEL,
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
            temperature: 0.1
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(`Mistral API error: ${JSON.stringify(data)}`);
        }

        const textResponse = data.choices[0].message.content;
        return JSON.parse(textResponse);
      } catch (error) {
        console.error('❌ Live Mistral parsing failed, falling back to heuristics:', error);
        return mockHeuristicParse(message);
      }
    } else {
      // Artificial minor delay to simulate network call
      await new Promise(resolve => setTimeout(resolve, 600));
      return mockHeuristicParse(message);
    }
  }
};

module.exports = mistralClient;
