# TWB House Buyers — Borrower Portal (Demo)

Minimal single-borrower mortgage note portal for **TWB House Buyers / Texas Wealth Builders**.

Informational + payment only. No leasing, work orders, or collections.

**QuickBooks Online is a payment processor only** — portal Pay posts Journal Entries with principal/interest coded from the local note/amort schedule. QBO is **not** linked to the amortization table, does **not** supply invoice history as the amort source, and does **not** issue invoices.

## Quick start

```bash
cd /workspace/twb-borrower-portal
cp .env.example .env   # already present with demo defaults
npm install
npm start
```

Open **http://localhost:3847**

| Item | Value |
|------|--------|
| Demo cell phone | set in `note.borrower.phone` / `DEMO_BORROWER_PHONE` |
| Demo password | `ABC12345` |
| Default port | `3847` |

Dev with auto-reload: `npm run dev`

## Routes

| Path | Description |
|------|-------------|
| `/login` | Demo borrower sign-in (session cookie) |
| `/dashboard` | Balance, next payment split, YTD interest, recent history |
| `/pay` | Fake card tokenization; one payment per calendar month; posts to QBO when configured |
| `/receipt/:id` | Confirmation + principal/interest + QBO status |
| `/amortization` | Local schedule from `data/amortization.json` (independent of QBO) |
| `/settings/qbo` | QBO connection status + **Connect QuickBooks** OAuth |
| `/oauth/connect` | Starts Intuit OAuth authorize redirect |
| `/oauth/callback` | OAuth redirect URI — exchanges code, stores tokens |
| `/health` | JSON health + QBO readiness |

## Sample note — Murillo

- Borrower: Jorge & Daniella Murillo (login = cell phone + temp password `ABC12345`)
- Property: 405 Habanero, Donna, TX 78537 (Hidalgo County)
- Note: **$59,590** · **9.68%** · payment **$562.28** · first payment **5/1/2017**
- Data: `data/note.json`, `data/payments.json`, `data/amortization.json` (local; not from QBO)

UI and footer are clearly labeled **DEMO**.

## Environment variables

See `.env.example`.

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port (default 3847) |
| `SESSION_SECRET` | Express session secret |
| `DEMO_BORROWER_PHONE` / `DEMO_BORROWER_PASSWORD` | Single demo login (cell + temp password) |
| `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` | Intuit Developer app OAuth client |
| `QBO_REDIRECT_URI` | Must match Intuit app exactly (default `http://localhost:3847/oauth/callback`) |
| `QBO_ENVIRONMENT` | `sandbox` (default) or `production` |
| `QBO_REALM_ID` | Company id (optional if obtained via `/oauth/callback`) |
| `QBO_REFRESH_TOKEN` / `QBO_ACCESS_TOKEN` | Optional manual tokens; prefer Connect flow |
| `QBO_BANK_DEPOSIT_ACCOUNT_ID` | Debit: Undeposited Funds or Bank |
| `QBO_PRINCIPAL_INCOME_OR_ASSET_ACCOUNT_ID` | Credit: Note Receivable (asset) |
| `QBO_INTEREST_INCOME_ACCOUNT_ID` | Credit: Interest Income |

**Without QBO vars**, payments still succeed locally. Receipt shows **Pending QuickBooks sync**.

Tokens from Connect are written to `data/qbo-tokens.json` (gitignored). Rotated refresh tokens are persisted there after each refresh.

## Payment behavior

1. Fake card form collects brand + last4 (nothing is charged; no Stripe keys needed).
2. Enforces **one payment per calendar month**.
3. Applies the next **local** amortization row (principal/interest split from Murillo schedule), updates balance + YTD interest in `data/note.json`, appends to `data/payments.json`.
4. Attempts QuickBooks Online **Journal Entry** via `services/qbo.js` using that same P/I split.
5. Redirects to receipt (`Synced` + JE id, or **Pending QuickBooks sync**).

## QuickBooks Online — Jason setup checklist

### Accounting mapping (seller-financed note)

Each portal payment posts **one Journal Entry** (same accounts every time):

| Side | Account type | Example name | Env var |
|------|--------------|--------------|---------|
| Debit (total) | Bank **or** Other Current Asset (Undeposited Funds) | Undeposited Funds / Operating Checking | `QBO_BANK_DEPOSIT_ACCOUNT_ID` |
| Credit (principal) | Other Current Asset | Note Receivable — Murillo / 405 Habanero | `QBO_PRINCIPAL_INCOME_OR_ASSET_ACCOUNT_ID` |
| Credit (interest) | Income | Interest Income — Seller Finance | `QBO_INTEREST_INCOME_ACCOUNT_ID` |

Create those accounts in the TWB QBO company if needed. Copy each account **Id**.

### Intuit Developer app + OAuth (in-portal)

1. Go to [https://developer.intuit.com](https://developer.intuit.com) and sign in with the Intuit account tied to the TWB QBO company.
2. **Create an app** → **QuickBooks Online and Payments** (Accounting scope is enough for Journal Entries).
3. Copy **Client ID** and **Client Secret** into `.env` (`QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`). Development keys for sandbox; Production keys for live.
4. Add Redirect URI **exactly**: `http://localhost:3847/oauth/callback` (or your deployed URL + `/oauth/callback`). Set `QBO_REDIRECT_URI` to match.
5. Set `QBO_ENVIRONMENT=sandbox` until you intentionally switch to production.
6. Fill the three account ID env vars from that company’s Chart of Accounts.
7. Restart `npm start`, sign in to the portal, open **QuickBooks** (`/settings/qbo`), click **Connect QuickBooks**.
8. Approve access on Intuit; callback stores `realmId` + tokens in `data/qbo-tokens.json`.
9. Make a demo payment — receipt should show **Synced** with a JE id when credentials and accounts are valid.

**Alternate:** Intuit OAuth 2.0 Playground with scope `com.intuit.quickbooks.accounting`, then paste realmId / refresh token into `.env` (Connect flow preferred).

### Notes / blockers

- You need a registered Intuit app, correct redirect URI, realm id, and tokens before live posts.
- Refresh tokens can rotate; this app persists new tokens to `data/qbo-tokens.json`.
- Do **not** commit Client Secrets or tokens.
- Sandbox vs production: wrong environment + realm combination fails the API call; local payment still succeeds.
- QBO does not drive amort; do not use QBO invoices for this note.

## Stack

- Node.js 18+ · Express · EJS · express-session · dotenv
- Persistence: JSON files under `data/`
- QBO: OAuth2 authorize + code exchange + refresh-token + Journal Entry (no required npm QBO SDK)

## Non-goals

Multi-borrower admin, leasing, work orders, collections, SMS/Twilio, QBO invoicing, QBO-as-amort-source.
