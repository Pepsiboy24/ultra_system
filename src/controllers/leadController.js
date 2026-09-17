/**
 * Lead Controller
 *
 * Exposes Express routing for landing-page early-access signups.
 * Endpoint: POST /api/leads (mounted at /api/leads in src/app.js).
 *
 * Captures leads for MANUAL follow-up only — this deliberately does not
 * connect any WhatsApp account or trigger Embedded Signup. Inserts into the
 * `leads` table via the shared db repository, matching the pattern used by
 * the other controllers (orderController, whatsappController).
 */

const express = require('express');
const router = express.Router();
const db = require('../config/db');

const VALID_CATEGORIES = ['dropshipper', 'restaurant', 'b2b'];

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

router.post('/', async (req, res) => {
  try {
    const { business_name, whatsapp_number, business_category, email } = req.body || {};

    if (!business_name || typeof business_name !== 'string' || business_name.trim() === '') {
      return res.status(400).json({ success: false, error: 'Please enter your business name.' });
    }

    const whatsappNumber = String(whatsapp_number || '').replace(/\D/g, '');
    if (whatsappNumber.length < 7) {
      return res.status(400).json({ success: false, error: 'Please enter a valid WhatsApp number.' });
    }

    if (!VALID_CATEGORIES.includes(business_category)) {
      return res.status(400).json({ success: false, error: `business_category must be one of: ${VALID_CATEGORIES.join(', ')}` });
    }

    if (!isEmail(email)) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }

    const lead = await db.createLead({
      business_name: business_name.trim(),
      whatsapp_number: whatsappNumber,
      business_category,
      email: String(email).trim().toLowerCase()
    });

    console.log(`🌱 New early-access lead: ${lead.business_name} (${lead.business_category}) — ${lead.whatsapp_number}`);
    res.status(201).json({ success: true, lead });
  } catch (error) {
    console.error('❌ Lead Capture Error:', error);
    res.status(500).json({ success: false, error: 'Could not save your details. Please try again.' });
  }
});

module.exports = router;
