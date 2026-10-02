'use strict';

/**
 * QuickBooks Online — payment processor only for the TWB borrower portal.
 *
 * Scope (authoritative):
 *   - OAuth connect to the TWB QBO company
 *   - Portal Pay posts a Journal Entry coded from the local note/amort + payment allocation
 *   - Borrower UI never shows QuickBooks; invoice apply targets live in payment.qboAllocation
 *   - Do NOT drive the amort table from QBO
 *
 * Journal Entry per payment (when OAuth is configured):
 *   Debit  Bank / Undeposited Funds   (total payment)
 *   Credit Note Receivable asset      (principal portion)
 *   Credit Interest Income            (interest portion)
 *   Credit Late fees income           (late-fee portion, if mapped)
 * PrivateNote includes per-invoice allocation (e.g. 1008 Sep + Oct invoice + accrued late fees).
 *
 * Raw HTTPS against Intuit OAuth + QBO v3 Accounting API (no intuit-oauth package).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const querystring = require('querystring');

const TOKEN_HOST = 'oauth.platform.intuit.com';
const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const API_HOST_SANDBOX = 'sandbox-quickbooks.api.intuit.com';
const API_HOST_PROD = 'quickbooks.api.intuit.com';
const ACCOUNTING_SCOPE = 'com.intuit.quickbooks.accounting';
const TOKENS_PATH = path.join(__dirname, '..', 'data', 'qbo-tokens.json');

function readStoredTokens() {
  try {
    if (!fs.existsSync(TOKENS_PATH)) return null;
    return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  } catch (err) {
    console.warn('QBO: could not read stored tokens:', err.message);
    return null;
  }
}

function writeStoredTokens(tokens) {
  const payload = {
    accessToken: tokens.accessToken || '',
    refreshToken: tokens.refreshToken || '',
    realmId: tokens.realmId || '',
    tokenType: tokens.tokenType || 'bearer',
    expiresAt: tokens.expiresAt || null,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

function clearStoredTokens() {
  try {
    if (fs.existsSync(TOKENS_PATH)) fs.unlinkSync(TOKENS_PATH);
  } catch (_) {
    /* ignore */
  }
}

function config() {
  const stored = readStoredTokens() || {};
  const port = Number(process.env.PORT) || 3847;
  return {
    clientId: process.env.QBO_CLIENT_ID || '',
    clientSecret: process.env.QBO_CLIENT_SECRET || '',
    realmId: process.env.QBO_REALM_ID || stored.realmId || '',
    refreshToken: process.env.QBO_REFRESH_TOKEN || stored.refreshToken || '',
    accessToken: process.env.QBO_ACCESS_TOKEN || stored.accessToken || '',
    accessExpiresAt: stored.expiresAt || null,
    environment: (process.env.QBO_ENVIRONMENT || 'sandbox').toLowerCase(),
    redirectUri:
      process.env.QBO_REDIRECT_URI || `http://localhost:${port}/oauth/callback`,
    bankAccountId: process.env.QBO_BANK_DEPOSIT_ACCOUNT_ID || '',
    principalAccountId: process.env.QBO_PRINCIPAL_INCOME_OR_ASSET_ACCOUNT_ID || '',
    interestAccountId: process.env.QBO_INTEREST_INCOME_ACCOUNT_ID || '',
  };
}

/** Client credentials present — enough to start OAuth. */
function hasOAuthApp(cfg = config()) {
  return Boolean(cfg.clientId && cfg.clientSecret);
}

/** Tokens + realm present (from env and/or data/qbo-tokens.json). */
function hasTokens(cfg = config()) {
  return Boolean(cfg.realmId && cfg.refreshToken);
}

/** Fully ready to post a Journal Entry. */
function isConfigured(cfg = config()) {
  return Boolean(
    hasOAuthApp(cfg) &&
      hasTokens(cfg) &&
      cfg.bankAccountId &&
      cfg.principalAccountId &&
      cfg.interestAccountId
  );
}

function missingFields(cfg = config()) {
  const map = {
    QBO_CLIENT_ID: cfg.clientId,
    QBO_CLIENT_SECRET: cfg.clientSecret,
    QBO_REALM_ID: cfg.realmId,
    QBO_REFRESH_TOKEN: cfg.refreshToken,
    QBO_BANK_DEPOSIT_ACCOUNT_ID: cfg.bankAccountId,
    QBO_PRINCIPAL_INCOME_OR_ASSET_ACCOUNT_ID: cfg.principalAccountId,
    QBO_INTEREST_INCOME_ACCOUNT_ID: cfg.interestAccountId,
  };
  return Object.keys(map).filter((k) => !map[k]);
}

function connectionStatus(cfg = config()) {
  return {
    oauthAppReady: hasOAuthApp(cfg),
    tokensPresent: hasTokens(cfg),
    accountsMapped: Boolean(
      cfg.bankAccountId && cfg.principalAccountId && cfg.interestAccountId
    ),
    readyToPost: isConfigured(cfg),
    environment: cfg.environment,
    realmId: cfg.realmId ? String(cfg.realmId) : null,
    redirectUri: cfg.redirectUri,
    missing: missingFields(cfg),
    scope: ACCOUNTING_SCOPE,
  };
}

function httpsRequest(host, method, reqPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: host, path: reqPath, method, headers };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_) {
          /* leave as text */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function createOAuthState() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Build Intuit authorize URL. Caller stores `state` in session for CSRF check.
 */
function getAuthorizeUrl(state, cfg = config()) {
  if (!hasOAuthApp(cfg)) {
    throw new Error('QBO OAuth app not configured (need QBO_CLIENT_ID and QBO_CLIENT_SECRET)');
  }
  const params = querystring.stringify({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: ACCOUNTING_SCOPE,
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/**
 * Exchange authorization code for tokens; persist to data/qbo-tokens.json.
 * @param {string} code
 * @param {string} realmId - from callback query (company id)
 */
async function exchangeAuthorizationCode(code, realmId, cfg = config()) {
  if (!hasOAuthApp(cfg)) {
    throw new Error('QBO OAuth app not configured');
  }
  if (!code) throw new Error('Missing authorization code');
  if (!realmId) throw new Error('Missing realmId from Intuit callback');

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const body = querystring.stringify({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
  });
  const res = await httpsRequest(TOKEN_HOST, 'POST', '/oauth2/v1/tokens/bearer', {
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });

  if (res.status !== 200 || !res.json || !res.json.access_token) {
    const detail = res.text || JSON.stringify(res.json);
    throw new Error(`QBO code exchange failed (${res.status}): ${detail}`);
  }

  const expiresIn = Number(res.json.expires_in) || 3600;
  const stored = writeStoredTokens({
    accessToken: res.json.access_token,
    refreshToken: res.json.refresh_token,
    realmId: String(realmId),
    tokenType: res.json.token_type || 'bearer',
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  });

  // Keep process.env in sync for this process (does not write .env)
  process.env.QBO_REALM_ID = stored.realmId;
  process.env.QBO_REFRESH_TOKEN = stored.refreshToken;
  process.env.QBO_ACCESS_TOKEN = stored.accessToken;

  return stored;
}

async function refreshAccessToken(cfg = config()) {
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    throw new Error('Cannot refresh QBO token — missing client credentials or refresh token');
  }
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const body = querystring.stringify({
    grant_type: 'refresh_token',
    refresh_token: cfg.refreshToken,
  });
  const res = await httpsRequest(TOKEN_HOST, 'POST', '/oauth2/v1/tokens/bearer', {
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });
  if (res.status !== 200 || !res.json || !res.json.access_token) {
    const detail = res.text || JSON.stringify(res.json);
    throw new Error(`QBO token refresh failed (${res.status}): ${detail}`);
  }

  const expiresIn = Number(res.json.expires_in) || 3600;
  const nextRefresh = res.json.refresh_token || cfg.refreshToken;
  const stored = writeStoredTokens({
    accessToken: res.json.access_token,
    refreshToken: nextRefresh,
    realmId: cfg.realmId,
    tokenType: res.json.token_type || 'bearer',
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  });

  process.env.QBO_REFRESH_TOKEN = stored.refreshToken;
  process.env.QBO_ACCESS_TOKEN = stored.accessToken;
  if (cfg.realmId) process.env.QBO_REALM_ID = cfg.realmId;

  return {
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
  };
}

/**
 * Prefer a non-expired stored access token; otherwise refresh.
 */
async function getAccessToken(cfg = config()) {
  if (cfg.accessToken && cfg.accessExpiresAt) {
    const expiresMs = Date.parse(cfg.accessExpiresAt);
    if (Number.isFinite(expiresMs) && expiresMs > Date.now() + 60_000) {
      return cfg.accessToken;
    }
  }
  const tokens = await refreshAccessToken(cfg);
  return tokens.accessToken;
}

/**
 * Post a note payment as a Journal Entry with local P/I split.
 * Never reads amort/invoices from QBO — payment coding comes from `payment` + `note`.
 */
async function postPayment(payment, note) {
  const cfg = config();
  if (!isConfigured(cfg)) {
    const missing = missingFields(cfg);
    const msg = `Pending QuickBooks sync — missing: ${missing.join(', ')}`;
    console.warn(`QBO skipped: ${msg}`);
    return { ok: false, skipped: true, status: 'skipped', message: msg };
  }

  try {
    const accessToken = await getAccessToken(cfg);
    const host = cfg.environment === 'production' ? API_HOST_PROD : API_HOST_SANDBOX;
    const minorversion = '65';

    const txnDate = payment.date || new Date().toISOString().slice(0, 10);
    const docNumber = (payment.confirmationId || '').slice(0, 21);
    const property =
      note && note.property
        ? `${note.property.address}, ${note.property.city} ${note.property.state}`
        : '';
    const alloc = payment.qboAllocation || {};
    const allocParts = (alloc.allocations || []).map((a) => {
      const inv = a.invoiceDocNumber ? `#${a.invoiceDocNumber}` : `${a.label} (create)`;
      const lf = a.lateFee ? ` + late fee $${Number(a.lateFee).toFixed(2)}` : '';
      return `${a.label} ${inv} $${Number(a.amount).toFixed(2)}${lf}`;
    });
    if (alloc.accruedLateFees > 0) {
      allocParts.push(`accrued late fees $${Number(alloc.accruedLateFees).toFixed(2)}`);
    }
    const allocNote = allocParts.length ? ` | Split: ${allocParts.join('; ')}` : '';
    const memo =
      `Note payment #${payment.paymentNumber} P/I — ${note?.borrower?.name || ''} — ${property}${allocNote}`.trim();

    const principal = Number(payment.principal);
    const interest = Number(payment.interest);
    const lateFees = Number(payment.lateFees || alloc.accruedLateFees || 0) || 0;
    const total = Number(payment.amount);
    const coded = principal + interest;
    // Prefer P/I from amort for receivable/interest; remainder (late fees) stays on principal credit if no late-fee account.
    let creditPrincipal = principal;
    let creditInterest = interest;
    if (Math.abs(coded - total) > 0.02 && lateFees > 0) {
      // Keep amort P/I; remaining dollars (late fees) credit the principal/receivable bucket until a late-fee account is mapped.
      const remainder = Math.round((total - coded) * 100) / 100;
      creditPrincipal = Math.round((principal + remainder) * 100) / 100;
    }

    if (!(total > 0) || !(creditPrincipal >= 0) || !(creditInterest >= 0)) {
      throw new Error('Invalid payment amounts for QBO post');
    }
    if (Math.abs(creditPrincipal + creditInterest - total) > 0.02) {
      console.warn(
        `QBO P/I check: principal ${creditPrincipal} + interest ${creditInterest} != total ${total}`
      );
    }

    const je = {
      DocNumber: docNumber,
      TxnDate: txnDate,
      PrivateNote: memo.slice(0, 4000),
      Line: [
        {
          Id: '0',
          Description: `Deposit — ${memo}`.slice(0, 4000),
          Amount: total,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: {
            PostingType: 'Debit',
            AccountRef: { value: cfg.bankAccountId },
          },
        },
        {
          Id: '1',
          Description: `Principal / receivable (incl. invoice apply targets in memo)`,
          Amount: creditPrincipal,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: {
            PostingType: 'Credit',
            AccountRef: { value: cfg.principalAccountId },
          },
        },
        {
          Id: '2',
          Description: `Interest Income`,
          Amount: creditInterest,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: {
            PostingType: 'Credit',
            AccountRef: { value: cfg.interestAccountId },
          },
        },
      ],
    };

    const body = JSON.stringify(je);
    const apiPath = `/v3/company/${cfg.realmId}/journalentry?minorversion=${minorversion}`;
    const res = await httpsRequest(host, 'POST', apiPath, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });

    if (res.status >= 200 && res.status < 300 && res.json && res.json.JournalEntry) {
      const txnId = String(res.json.JournalEntry.Id);
      console.log(`QBO Journal Entry created: ${txnId} (P=${principal} I=${interest} T=${total})`);
      return {
        ok: true,
        skipped: false,
        status: 'synced',
        message: 'Posted to QuickBooks Online',
        txnId,
      };
    }

    const errMsg = `QBO post failed (${res.status}): ${res.text || JSON.stringify(res.json)}`;
    console.error(errMsg);
    return { ok: false, skipped: false, status: 'error', message: errMsg };
  } catch (err) {
    const msg = `QBO error: ${err.message}`;
    console.error(msg);
    return { ok: false, skipped: false, status: 'error', message: msg };
  }
}

module.exports = {
  ACCOUNTING_SCOPE,
  TOKENS_PATH,
  config,
  hasOAuthApp,
  hasTokens,
  isConfigured,
  missingFields,
  connectionStatus,
  createOAuthState,
  getAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  getAccessToken,
  postPayment,
  readStoredTokens,
  writeStoredTokens,
  clearStoredTokens,
};
