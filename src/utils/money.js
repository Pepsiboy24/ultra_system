/**
 * Customer-facing naira formatting: ₦45,000 for whole amounts, ₦1,250.50
 * otherwise. DISPLAY ONLY — arithmetic elsewhere keeps its own rounding.
 */
function formatNaira(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '₦0';
  const rounded = Math.round(n * 100) / 100;
  const [whole, dec] = Math.abs(rounded).toFixed(2).split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = rounded < 0 ? '-' : '';
  return `${sign}₦${withCommas}${Number.isInteger(rounded) ? '' : `.${dec}`}`;
}

module.exports = { formatNaira };
