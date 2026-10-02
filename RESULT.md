# RESULT — TWB Borrower Portal (revised QBO payments scope)

## What changed

Revised QuickBooks Online scope: **payment processor only**.

- OAuth connect/callback at `/oauth/connect` + `/oauth/callback` (settings UI `/settings/qbo`)
- Pay posts Journal Entry with **principal/interest split** from local Murillo amort row
- Amortization remains local (`data/amortization.json`) — **not** linked to QBO invoices/history
- Murillo note terms in `data/note.json`: $59,590 · 9.68% · $562.28 · first payment 5/1/2017
- Graceful **Pending QuickBooks sync** when env/tokens/accounts missing
- Navy `#0B1F3A` / gold `#C4A35A` aesthetic unchanged

## Files changed

| Path | Change |
|------|--------|
| `services/qbo.js` | OAuth authorize URL, code exchange, token persist (`data/qbo-tokens.json`), refresh, JE post with P/I |
| `routes/oauth.js` | `/settings/qbo`, `/oauth/connect`, `/oauth/callback`, `/oauth/disconnect` |
| `views/qbo-settings.ejs` | Connection status + Connect button |
| `views/layout-start.ejs` | QuickBooks nav link |
| `views/amortization.ejs` | Badge → LOCAL SCHEDULE |
| `views/pay.ejs` | Placeholder name |
| `server.js` | Mount OAuth routes; health/QBO status; Pay → `qbo.postPayment` |
| `data/note.json` | Murillo note + state (next due 10/1/2026 payment #114) |
| `data/amortization.json` | 241-row Murillo schedule from note terms |
| `data/payments.json` | Recent 12 months local history |
| `.env.example` / `.env` | `QBO_REDIRECT_URI` + clearer payment-processor docs |
| `.gitignore` | `data/qbo-tokens.json` |
| `README.md` / `RESULT.md` | Revised scope + Jason blockers |
| `public/css/styles.css` | Minor helpers for settings page |

## How OAuth works

1. Jason puts Intuit **Client ID/Secret** (and account IDs) in `.env`; redirect URI = `QBO_REDIRECT_URI`.
2. Signed-in user opens `/settings/qbo` → **Connect QuickBooks** → `/oauth/connect`.
3. Portal stores CSRF `state` in session, redirects to Intuit authorize (`com.intuit.quickbooks.accounting`).
4. Intuit redirects to `/oauth/callback?code=…&realmId=…&state=…`.
5. Portal verifies state, exchanges code for access + refresh tokens, saves **realmId + tokens** to `data/qbo-tokens.json` (also mirrors into process env for the running process).
6. Later Pay calls refresh (or uses non-expired access token) and posts the JE.

## How Pay posts with P/I split

1. `store.applyPayment` takes the next row from **local** `amortization.json` → principal, interest, amount.
2. Local `note.json` / `payments.json` updated first (payment always succeeds locally).
3. `qbo.postPayment(payment, note)` builds one Journal Entry:
   - Debit bank/undeposited = **total**
   - Credit note receivable = **principal**
   - Credit interest income = **interest**
4. Receipt shows Synced + JE id, or **Pending QuickBooks sync** if not configured / API error text if post failed.

## How to run

```bash
cd /workspace/twb-borrower-portal
npm install
npm start
```

- URL: http://localhost:3847
- Login: `maria.rodriguez@example.com` / `demo1234`

## Blockers for Jason

1. **Register Intuit Developer app** (QuickBooks Online) — obtain Client ID + Client Secret.
2. **Redirect URI** must match exactly: `http://localhost:3847/oauth/callback` (or production URL) and `QBO_REDIRECT_URI`.
3. **Connect** via `/settings/qbo` (or Playground) to obtain **realmId** + refresh/access tokens.
4. **Chart of Accounts IDs** in that same company: bank/undeposited, note receivable, interest income → three env vars.
5. Choose **sandbox vs production** keys/company consistently (`QBO_ENVIRONMENT`).
6. Do not invent secrets; leave blank until real values exist — portal runs with Pending QuickBooks sync.

**Blocker today:** no live QBO credentials in the environment (by design).
