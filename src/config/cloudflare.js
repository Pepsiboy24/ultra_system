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
 * Restaurant term-extraction helpers for the mock menu parser. This SIMULATES
 * the three-outcome classification the live prompt produces:
 *   - a clause that matches exactly one menu item  -> "matched"
 *   - a clause that matches several menu items     -> "ambiguous"
 *   - a clause that matches no menu item           -> "no_match"
 *
 * Messages are split into clauses on commas / "and" / "with" / "plus", then
 * each clause is cleaned of quantities, question-lead fluff ("what of",
 * "can i", "i want", ...) and filler. Digits (or number words) become the
 * item's quantity.
 */

// Spoken quantities, so "three jollof rice" behaves like "3 jollof rice".
const MENU_NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};

// Leading conversational fluff stripped from a clause before matching, so
// "what of the chicken" or "can i add rice" reduce to the actual item term.
const MENU_CLAUSE_LEAD_FLUFF = [
  'what about', 'what of', 'what is', 'what are', "what's",
  'how about', 'how much is', 'how much',
  'can i get', 'can i have', 'can i', 'could i get', 'could i have', 'could i',
  'i would like', 'i want to', 'i want', "i'd like", 'i will have', 'i will',
  'i need', 'please give me', 'please add', 'please',
  'give me', 'gimme', 'one of', 'also want', 'also', 'add',
  'with', 'and', 'the', 'a', 'an', 'some', 'my'
];

/**
 * Clean a single message clause into a { term, quantity } pair.
 * @param {string} clause
 * @returns {{ term: string, quantity: number }}
 */
function cleanMenuClause(clause) {
  let t = String(clause || '')
    .toLowerCase()
    .replace(/^['"(]+/, '')
    .replace(/['"?.,;!)]+$/, '')
    .trim();

  let quantity = 0;
  let match = t.match(/^(\d+)\s+/);
  if (match) {
    quantity = parseInt(match[1], 10) || 1;
    t = t.slice(match[0].length).trim();
  } else {
    for (const [word, n] of Object.entries(MENU_NUMBER_WORDS)) {
      const wm = new RegExp(`^${word}\\s+(.{2,})`);
      if (wm.test(t)) {
        quantity = n;
        t = t.replace(wm, '$1').trim();
        break;
      }
    }
  }

  let prev;
  do {
    prev = t;
    for (const lead of MENU_CLAUSE_LEAD_FLUFF) {
      const re = new RegExp(`^${lead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`);
      if (re.test(t)) {
        t = t.replace(re, '').trim();
        break;
      }
    }
  } while (t !== prev);

  t = t.replace(/\s+(please|that's all|thats all|only|ok|okay)$/i, '').trim();

  return { term: t, quantity: quantity || 1 };
}

/**
 * Split a customer message into candidate menu terms (clause-based).
 * @param {string} message
 * @returns {Array<{ term: string, quantity: number }>}
 */
function mockMenuTerms(message) {
  const clauses = String(message || '')
    .split(/[;,]|\band\b|\bplus\b|\bwith\b|&/i)
    .map(c => c.trim())
    .filter(Boolean);

  const seen = new Set();
  const terms = [];
  for (const clause of clauses) {
    const { term, quantity } = cleanMenuClause(clause);
    if (!term || term.length < 3 || seen.has(term)) {
      if (term && term.length >= 3) seen.add(term);
      continue;
    }
    seen.add(term);
    terms.push({ term, quantity });
  }
  return terms;
}

/**
 * Mock simulation of MENU-BASED matching (restaurant category): each extracted
 * clause is classified against the menu into one of the three outcomes the
 * live prompt returns (matched / ambiguous / no_match), so the mock and live
 * behavior stay aligned. A term that matches several items is ALWAYS reported
 * as ambiguous (never silently guessed); a term that matches none is reported
 * as no_match for downstream suggestion handling. This keeps mock and live
 * behavior aligned: the parse never returns a name we don't own.
 *
 * @param {string} message
 * @param {Array<Object>} menuItems - [{ id, name, ... }]
 * @returns {{ items: Array<Object> }}
 *   items: [{ term, quantity, modifiers, outcome, product_id, candidates, suggested_category }]
 */
function mockMenuParse(message, menuItems) {
  const menu = Array.isArray(menuItems) ? menuItems : [];
  const namesOverlap = (catalogName, searchName) => {
    const catalog = String(catalogName || '').toLowerCase();
    const search = String(searchName || '').toLowerCase();
    if (!catalog || !search) return false;
    return catalog.includes(search) || search.includes(catalog);
  };

  const items = [];
  for (const clause of mockMenuTerms(message)) {
    const matches = menu.filter(m => namesOverlap(m.name, clause.term));
    if (matches.length === 1) {
      items.push({
        term: clause.term,
        outcome: 'matched',
        product_id: matches[0].id,
        quantity: clause.quantity,
        modifiers: [],
        candidates: [],
        suggested_category: null
      });
    } else if (matches.length > 1) {
      items.push({
        term: clause.term,
        outcome: 'ambiguous',
        product_id: null,
        quantity: clause.quantity,
        modifiers: [],
        candidates: matches.map(m => m.id),
        suggested_category: null
      });
    } else {
      items.push({
        term: clause.term,
        outcome: 'no_match',
        product_id: null,
        quantity: clause.quantity,
        modifiers: [],
        candidates: [],
        suggested_category: null
      });
    }
  }

  return { items };
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
  },

  /**
   * Menu-based order parsing for 'restaurant' category clients: the client's
   * full menu is passed as structured context and the model must classify each
   * item as matched / ambiguous / no_match using exact product ids from it.
   * Never free-text names; ids are re-verified server-side by restaurantService.
   *
   * Normalizes the model response into a stable shape handled by aiService:
   *   { items: [{ term, outcome, quantity, modifiers, product_id, candidates, suggested_category }] }
   *
   * @param {string} message - Incoming order text
   * @param {Array<Object>} menuItems - Client menu rows ({ id, name, ... })
   * @param {Function|null} [buildPrompt] - (message) => promptString.
   *   When null, the restaurant menu prompt (restaurantPrompts.buildMenuPrompt)
   *   is used.
   * @returns {Promise<{ items: Array<Object> }>}
   */
  async parseOrderWithMenu(message, menuItems = [], buildPrompt = null) {
    if (!isMock) {
      try {
        const prompt = buildPrompt
          ? buildPrompt(message)
          : require('./prompts/restaurantPrompts').buildMenuPrompt(menuItems, message);

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

        const raw = data.result.response;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
          items: Array.isArray(parsed.items) ? parsed.items : []
        };
      } catch (error) {
        console.error('❌ Live menu-based parsing failed, falling back to mock menu match:', error);
        return mockMenuParse(message, menuItems);
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 600));
      return mockMenuParse(message, menuItems);
    }
  }
};

module.exports = cloudflareClient;
