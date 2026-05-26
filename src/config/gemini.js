/**
 * Gemini AI Client Setup
 * 
 * Configures the Google Generative AI client.
 * If the GEMINI_API_KEY is not defined or is placeholder,
 * it returns a Mock AI client that uses regex-based NLP heuristics
 * to simulate Gemini order extraction out-of-the-box.
 */

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

function isGeminiConfigured() {
  const key = process.env.GEMINI_API_KEY;
  return key && key !== 'your-gemini-api-key' && key.trim() !== '';
}

const isMock = !isGeminiConfigured();
let genAI = null;

if (!isMock) {
  console.log('⚡ Pipeline Gemini: Configured to use live Gemini 1.5 Flash.');
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
} else {
  console.log('⚡ Pipeline Gemini: Configured to use mock AI heuristic parser.');
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
    // Attempt dynamic extraction: e.g. "this is [Name]" or "i am [Name]" or "here is [Name]"
    const supplierRegex = /(?:this is|i am|from|here is|hi,?\s+this is|hello,?\s+this is)\s+([a-z\s]+?)(?=\.|,|\band\b|\bwe\b|\bneed\b|\bwant\b|\bto\b|$)/i;
    const match = message.match(supplierRegex);
    if (match && match[1]) {
      supplierName = match[1].trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
  }

  // 2. Items Extraction Heuristics
  const items = [];
  
  // Regex to match "10 bags of Earl Grey" or "5 Earl Grey" or "30 bags of Ceremonial Matcha"
  // Captures: quantity, optional unit ("bags", "bags of", etc.), product name
  const itemRegex = /(\d+)\s*(?:bags\s*of|bags|packs\s*of|packs|units\s*of|units)?\s*([a-z\s]+?)(?=\d+|,|\band\b|\.|$)/gi;
  
  let match;
  while ((match = itemRegex.exec(message)) !== null) {
    const qty = parseInt(match[1], 10);
    let rawProdName = match[2].trim();
    
    // Clean up product name (remove trailing/leading non-alphabetical or filler words)
    rawProdName = rawProdName.replace(/^(and|we|want|need|order|request|to)\s+/i, '');
    rawProdName = rawProdName.replace(/\s+(and|we|want|need|order)\s*$/i, '');
    
    let matchedProdName = rawProdName;

    // Map keywords to standard inventory names
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
      // Capitalize first letters of parsed product name if no match
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

const geminiClient = {
  isMock,
  
  /**
   * Parses natural language using Gemini 1.5 Flash or Heuristics
   */
  async parseOrderMessage(message) {
    if (!isMock) {
      try {
        const model = genAI.getGenerativeModel({
          model: 'gemini-1.5-flash',
          generationConfig: {
            responseMimeType: 'application/json',
          }
        });

        const prompt = `You are a B2B order processing assistant. Your task is to parse an incoming natural language WhatsApp message from a tea supplier/customer and convert it into a structured B2B order JSON.

Extract:
1. The supplier or customer name.
2. The ordered items, matching them as closely as possible to standard tea product names (e.g. 'Earl Grey Blend', 'Chamomile Fields', 'Ceremonial Matcha', 'English Breakfast').

Input Message:
"${message}"

Return JSON matching this exact structure:
{
  "supplier_name": "Supplier/Customer Name",
  "items": [
    {
      "product_name": "Standard Tea Name",
      "quantity": 10
    }
  ]
}`;

        const result = await model.generateContent(prompt);
        const textResponse = result.response.text();
        return JSON.parse(textResponse);
      } catch (error) {
        console.error('❌ Live Gemini parsing failed, falling back to heuristics:', error);
        return mockHeuristicParse(message);
      }
    } else {
      // Artificial minor delay to simulate network call
      await new Promise(resolve => setTimeout(resolve, 600));
      return mockHeuristicParse(message);
    }
  }
};

module.exports = geminiClient;
