# Setup notes for this update

## 1. New Worker secrets  (npx wrangler secret put NAME)
| Secret | What it is | Needed for |
|---|---|---|
| META_APP_SECRET | Meta developer dashboard -> App settings -> Basic -> App secret | Rejects fake WhatsApp webhooks |
| DASHBOARD_API_KEY | Any long random string you invent (e.g. 32+ characters) | Unlocks /api/dashboard and /api/process-order |
| KITCHEN_CANCEL_TEMPLATE | (optional) name of a cancellation template, 2 variables: {{1}} order number, {{2}} items | Cancel notices to a kitchen outside the 24h window |
| MAX_MESSAGES_PER_MINUTE | (optional) default 20 | Per-sender spam limit |

Already set earlier: ALERT_PHONE, KITCHEN_TICKET_TEMPLATE.

Suggested cancellation template (Utility, English):
  "Order cancelled: customer has cancelled order {{1}} ({{2}}). Please do not prepare this order."

## 2. Database (Supabase SQL editor, run once)
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS info_text TEXT;
(also saved as db/migrations/0004_restaurant_info.sql)

## 3. Menu import
    node scripts/importMenu.js --client <client-uuid or business number> --file menu.csv --dry-run
    node scripts/importMenu.js --client <client-uuid or business number> --file menu.csv
