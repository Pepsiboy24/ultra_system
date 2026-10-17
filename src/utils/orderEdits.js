/**
 * Deterministic parsing of order edits typed at the confirm step:
 *   "remove the chicken", "make it 3", "add one more", "2 more rice" ...
 * Pure text matching against the items already in the pending order — no AI,
 * no prices. Returns null when the message isn't recognisably an edit, so the
 * caller falls through to its existing logic.
 *
 * Result shapes:
 *   { kind: 'set',      index, qty }
 *   { kind: 'add',      index, qty }
 *   { kind: 'remove',   index, qty }      // qty === null -> remove the whole line
 *   { kind: 'ask',      verb, candidates: [index, ...] }  // which item did you mean?
 *   { kind: 'notfound', target }
 */

const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12
};
const NUM = '(\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const STOP = new Set([
  'the', 'a', 'an', 'my', 'that', 'this', 'those', 'of', 'one', 'portion', 'portions',
  'plate', 'plates', 'pack', 'packs', 'order', 'orders', 'some', 'any', 'it', 'them'
]);
const WHOLE_ORDER_RE = /^(?:the\s+|my\s+)?(?:whole\s+|entire\s+)?(?:order|everything|all|all\s+of\s+it)$/;

function toNum(s) {
  const t = String(s).toLowerCase();
  if (/^\d{1,3}$/.test(t)) return parseInt(t, 10);
  return NUM_WORDS[t] ?? null;
}

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

function clean(text) {
  let t = String(text || '').toLowerCase().replace(/[’‘]/g, "'").trim();
  t = t.replace(/[.!?,]+$/g, '').replace(/\s+/g, ' ');
  t = t.replace(/^(?:(?:please|pls|plz|abeg|kindly|ok|okay|wait|sorry|actually|hmm|so|and|oh)\b[\s,]*)+/, '');
  t = t.replace(/[\s,]*(?:please|pls|plz|abeg|o|biko)$/, '');
  return t.trim();
}

/** Which order lines does `target` refer to? (all target words must appear in the item name) */
function matchItems(items, target) {
  const want = tokens(target).filter(w => !STOP.has(w));
  if (want.length === 0) return null; // no usable target
  const out = [];
  items.forEach((it, i) => {
    const have = new Set(tokens(it.product_name));
    if (want.every(w => have.has(w))) out.push(i);
  });
  return out;
}

function resolveTarget(items, rawTarget, verb, qty, { explicitRemove = false } = {}) {
  const target = (rawTarget || '').trim();
  if (target && WHOLE_ORDER_RE.test(target)) return null;

  const matches = target ? matchItems(items, target) : null;
  if (matches === null) {
    // No (usable) target word: "make it 3", "add one more", "remove it".
    if (items.length === 1) return { index: 0 };
    return { ask: { kind: 'ask', verb, candidates: items.map((_, i) => i) } };
  }
  if (matches.length === 1) return { index: matches[0] };
  if (matches.length > 1) return { ask: { kind: 'ask', verb, candidates: matches } };
  // Nothing in the order matches. Only claim "not in your order" for explicit
  // removal verbs; otherwise let the normal flow (e.g. adding a menu dish) run.
  if (verb === 'remove' && explicitRemove) return { ask: { kind: 'notfound', target } };
  return null;
}

function parseOrderEdit(text, items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const t = clean(text);
  if (!t || t.length > 80) return null;
  let m;

  // ---- remove ---------------------------------------------------------
  m = t.match(new RegExp(`^(remove|delete|drop|comot|take\\s+out|take\\s+off|cancel|no|without)\\s+(?:(?:the|my|that|this)\\s+)?(?:${NUM}\\s+(?:of\\s+)?(?:the\\s+)?)?(.+)$`));
  if (m) {
    const explicit = !['cancel', 'no', 'without'].includes(m[1]);
    const qty = m[2] ? toNum(m[2]) : null;
    const r = resolveTarget(items, m[3], 'remove', qty, { explicitRemove: explicit });
    if (!r) return null;
    if (r.ask) return r.ask;
    return { kind: 'remove', index: r.index, qty };
  }
  m = t.match(/^(?:i\s+)?(?:don'?t|do\s+not|no)\s+want\s+(?:(?:the|any)\s+)?(.+?)(?:\s+(?:again|anymore|any\s+more))?$/);
  if (m) {
    const r = resolveTarget(items, m[1], 'remove', null, { explicitRemove: true });
    if (!r) return null;
    if (r.ask) return r.ask;
    return { kind: 'remove', index: r.index, qty: null };
  }
  m = t.match(/^(?:remove|delete|drop|take\s+out|comot)\s+(?:it|that|this)$/);
  if (m) {
    const r = resolveTarget(items, '', 'remove', null);
    if (r && r.ask) return r.ask;
    if (r) return { kind: 'remove', index: r.index, qty: null };
  }

  // ---- set quantity ---------------------------------------------------
  let target = null, qty = null;
  if ((m = t.match(new RegExp(`^(?:make|change|set|update|put)\\s+(?:it|that|this|them)\\s+(?:to\\s+|as\\s+|into\\s+)?${NUM}$`)))) {
    target = ''; qty = toNum(m[1]);
  } else if ((m = t.match(new RegExp(`^(?:change|set|update)\\s+(?:the\\s+)?(?:quantity|qty|number)(?:\\s+of\\s+(?:the\\s+)?(.+?))?\\s+to\\s+${NUM}$`)))) {
    target = m[1] || ''; qty = toNum(m[2]);
  } else if ((m = t.match(new RegExp(`^(?:make|change|set|update|put)\\s+(?:the\\s+)?(.+?)\\s+(?:to\\s+|as\\s+|into\\s+)?${NUM}$`)))) {
    target = m[1]; qty = toNum(m[2]);
  } else if ((m = t.match(new RegExp(`^(?:just|only)\\s+${NUM}(?:\\s+(?:of\\s+)?(?:the\\s+)?(.+))?$`)))) {
    qty = toNum(m[1]); target = m[2] || '';
  } else if ((m = t.match(new RegExp(`^${NUM}\\s+(?:of\\s+)?(?:the\\s+)?(.+?)\\s+(?:only|in\\s+total|total|instead)$`)))) {
    qty = toNum(m[1]); target = m[2];
  }
  if (qty !== null) {
    const r = resolveTarget(items, target, 'set', qty);
    if (!r) return null;
    if (r.ask) return { ...r.ask, qty };
    return qty === 0 ? { kind: 'remove', index: r.index, qty: null } : { kind: 'set', index: r.index, qty };
  }

  // ---- add more -------------------------------------------------------
  let addQty = null; target = '';
  if ((m = t.match(new RegExp(`^(?:add\\s+)?${NUM}\\s+more(?:\\s+(?:of\\s+)?(?:the\\s+)?(.+))?$`)))) {
    addQty = toNum(m[1]); target = m[2] || '';
  } else if ((m = t.match(/^(?:add\s+)?another(?:\s+one)?$/))) {
    addQty = 1; target = '';
  } else if ((m = t.match(/^(?:add\s+)?another\s+(?:(?:one|portion|plate|pack)\s+of\s+)?(?:the\s+)?(.+)$/))) {
    addQty = 1; target = m[1];
  }
  if (addQty !== null && addQty > 0) {
    const r = resolveTarget(items, target, 'add', addQty);
    if (!r) return null;
    if (r.ask) return { ...r.ask, qty: addQty };
    return { kind: 'add', index: r.index, qty: addQty };
  }

  return null;
}

module.exports = { parseOrderEdit, toNum };
