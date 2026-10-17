/**
 * Varied welcome messages for the restaurant flow. Pure wording — no facts
 * beyond the business name and the customer's saved first name.
 */
const EXAMPLE = '"2 jollof rice, 1 chicken"';

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** Echo the customer's own time-of-day greeting ("good morning" -> "Good morning"). */
function timeOfDayOpener(text) {
  const m = String(text || '').match(/good\s+(morning|afternoon|evening)/i);
  return m ? `Good ${m[1].toLowerCase()}` : null;
}

function buildWelcome({ businessName, customerName, text }) {
  const biz = businessName || 'our restaurant';
  const tod = timeOfDayOpener(text);

  if (customerName) {
    const opener = tod ? `${tod}, ${customerName}!` : null;
    const variants = [
      `Welcome back, ${customerName}! 👋 What are we having today? Send your order, or type MENU to see what's available.`,
      `Hey ${customerName}, good to see you again! 😊 What can I get you today? (Type MENU to browse.)`,
      `Hi ${customerName}! Great to have you back at ${biz}. What would you like today? Type MENU to see what's available.`
    ];
    if (opener) {
      return `${opener} 👋 Welcome back to ${biz}. What can I get you today? Send your order, or type MENU to browse.`;
    }
    return pick(variants);
  }

  const lead = tod ? `${tod}!` : null;
  const variants = [
    `👋 Welcome to ${biz}! What can I get you? Try something like ${EXAMPLE}, or type MENU to see what's available.`,
    `Hi there! 😊 Thanks for messaging ${biz}. Tell me what you'd like (e.g. ${EXAMPLE}), or type MENU to browse.`,
    `Hello, and welcome to ${biz}! 👋 Send me your order (e.g. ${EXAMPLE}), or type MENU to see what's on today.`
  ];
  if (lead) {
    return `${lead} 👋 Welcome to ${biz}! Tell me what you'd like to order (e.g. ${EXAMPLE}), or type MENU to see what's available.`;
  }
  return pick(variants);
}

module.exports = { buildWelcome };
