-- ============================================================
-- Live DB migration — owner-written restaurant info.
-- Run ONCE in the Supabase SQL editor (safe to re-run).
--
-- Lets a restaurant owner text  INFO <opening hours, delivery areas & fees,
-- how customers pay, address>  to the bot; the bot then answers questions
-- like "what time do you close?" from that text (and only that text).
-- ============================================================
ALTER TABLE clients ADD COLUMN IF NOT EXISTS info_text TEXT;
